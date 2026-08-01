/**
 * 文档控制器：打开、保存、脏标记、冲突处理。
 *
 * 刻意做成不依赖 DOM 的纯逻辑类（只依赖 HostBridge 和一个极小的编辑器接口），
 * 这样 04 号文档里那些「必须有的防灾测试」可以用内存 HostBridge 直接跑，
 * 不需要启动 Electron。
 */
import type { HostBridge, TextFileMeta } from '@typo/plugin-api'

/** 控制器需要编辑器提供的最小能力。 */
export interface EditorHandle {
  getDoc(): string
  setDoc(text: string, options?: { readOnly?: boolean }): void
  replaceDoc(text: string): void
}

export interface DocumentState {
  path: string | null
  name: string
  dirty: boolean
  readOnly: boolean
  meta: TextFileMeta
}

const UNTITLED = '未命名.md'
const DEFAULT_META: TextFileMeta = { encoding: 'utf8', eol: 'lf', mixedEol: false }

function basename(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return index === -1 ? filePath : filePath.slice(index + 1)
}

export class DocumentController {
  private filePath: string | null = null
  private meta: TextFileMeta = { ...DEFAULT_META }
  /** 上次读/写时磁盘内容的 hash，用于冲突检测。null 表示尚未落盘。 */
  private baselineHash: string | null = null
  /** 上次落盘的文本，脏标记以它为准。 */
  private savedText = ''
  private readOnly = false

  constructor(
    private readonly host: HostBridge,
    private readonly editor: EditorHandle,
    private readonly onChange: (state: DocumentState) => void,
  ) {}

  state(): DocumentState {
    return {
      path: this.filePath,
      name: this.filePath ? basename(this.filePath) : UNTITLED,
      dirty: this.isDirty(),
      readOnly: this.readOnly,
      meta: this.meta,
    }
  }

  isDirty(): boolean {
    return this.editor.getDoc() !== this.savedText
  }

  private emit(): void {
    this.onChange(this.state())
  }

  /** 内容变化时由编辑器回调，用于刷新脏标记。 */
  notifyEdited(): void {
    this.emit()
  }

  async newFile(): Promise<void> {
    if (!(await this.confirmDiscard())) return
    this.filePath = null
    this.meta = { ...DEFAULT_META }
    this.baselineHash = null
    this.savedText = ''
    this.readOnly = false
    this.editor.setDoc('', { readOnly: false })
    this.emit()
  }

  async openViaDialog(): Promise<void> {
    if (!(await this.confirmDiscard())) return
    const picked = await this.host.dialog.openFile()
    const target = picked?.[0]
    if (target) await this.openPath(target, { alreadyConfirmed: true })
  }

  async openPath(target: string, options: { alreadyConfirmed?: boolean } = {}): Promise<void> {
    if (!options.alreadyConfirmed && !(await this.confirmDiscard())) return

    try {
      const result = await this.host.fs.read(target)
      this.filePath = target
      this.meta = result.meta
      this.baselineHash = result.hash
      this.savedText = result.text
      this.readOnly = result.readOnly
      this.editor.setDoc(result.text, { readOnly: result.readOnly })
      this.emit()

      // 已知损耗必须当面告知，不能等用户保存完才发现文件被改了
      if (result.meta.mixedEol) {
        await this.host.dialog.message({
          message: '该文件包含混合换行符',
          detail: `保存时会统一为 ${result.meta.eol === 'crlf' ? 'CRLF' : 'LF'}。如果不希望这样，请先用其他工具统一换行符。`,
        })
      }
      if (result.readOnly) {
        await this.host.dialog.message({
          message: '文件为只读',
          detail: '编辑器已进入只读模式。若要修改，请先调整文件权限或使用「另存为」。',
        })
      }
    } catch (error) {
      await this.host.dialog.message({
        message: '无法打开文件',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** @returns 是否真的保存了 */
  async save(): Promise<boolean> {
    if (!this.filePath) return this.saveAs()
    if (this.readOnly) {
      await this.host.dialog.message({
        message: '文件为只读，无法保存',
        detail: '请使用「另存为」保存到别处。',
      })
      return false
    }
    return this.writeTo(this.filePath, this.baselineHash)
  }

  async saveAs(): Promise<boolean> {
    const target = await this.host.dialog.saveFile({
      defaultPath: this.filePath ?? UNTITLED,
    })
    if (!target) return false
    // 另存为的目标可能是一个已存在的文件，此时没有基线可比 —— 传 null 表示
    // 「我知道我在覆盖」，因为用户刚在保存对话框里确认过一次
    const ok = await this.writeTo(target, null)
    if (ok) {
      this.filePath = target
      this.readOnly = false
      this.emit()
    }
    return ok
  }

  private async writeTo(target: string, expectedHash: string | null): Promise<boolean> {
    const text = this.editor.getDoc()
    try {
      const result = await this.host.fs.write(target, text, { meta: this.meta, expectedHash })
      this.baselineHash = result.hash
      this.savedText = text
      this.emit()
      return true
    } catch (error) {
      if (error instanceof Error && error.name === 'ConflictError') {
        return this.resolveConflict(target, text)
      }
      await this.host.dialog.message({
        message: '保存失败',
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * 外部修改冲突（docs/design/04 §3）。
   *
   * 绝不静默覆盖 —— 用户在别处改过的内容一旦被无声盖掉，就是不可挽回的数据丢失。
   */
  private async resolveConflict(target: string, text: string): Promise<boolean> {
    const choice = await this.host.dialog.confirm({
      message: '文件已被其他程序修改',
      detail:
        '磁盘上的内容与你打开时不同。要用当前编辑器里的内容覆盖它，还是放弃本地修改重新载入？',
      buttons: ['覆盖磁盘上的内容', '重新载入磁盘内容', '取消'],
      defaultId: 2,
      cancelId: 2,
    })

    if (choice === 0) {
      const result = await this.host.fs.write(target, text, {
        meta: this.meta,
        expectedHash: null,
      })
      this.baselineHash = result.hash
      this.savedText = text
      this.emit()
      return true
    }

    if (choice === 1) {
      const result = await this.host.fs.read(target)
      this.meta = result.meta
      this.baselineHash = result.hash
      this.savedText = result.text
      // 用 replaceDoc 而不是 setDoc：保留撤销栈，用户还能把自己的版本撤回来
      this.editor.replaceDoc(result.text)
      this.emit()
      return false
    }

    return false
  }

  /** @returns 是否可以继续（丢弃或已保存） */
  private async confirmDiscard(): Promise<boolean> {
    if (!this.isDirty()) return true
    const choice = await this.host.dialog.confirm({
      message: `是否保存对「${this.state().name}」的修改？`,
      detail: '不保存的话，这些修改会丢失。',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
    })
    if (choice === 0) return this.save()
    return choice === 1
  }

  /** 窗口关闭前的确认。 */
  async canClose(): Promise<boolean> {
    return this.confirmDiscard()
  }
}
