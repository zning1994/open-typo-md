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

/** 监听与草稿这两件事需要宿主配合，但它们跟文件读写不是一码事，单独一组。 */
export interface DocumentSideEffects {
  /** 开始 / 停止监听当前文件。 */
  watch(path: string | null): Promise<void>
  /** 写草稿。key 由控制器给出，保证同一份文档反复写的是同一个草稿。 */
  writeDraft(key: string, text: string, meta: DraftLike): Promise<void>
  dropDraft(key: string): Promise<void>
}

export interface DraftLike {
  path: string | null
  baselineHash: string | null
  savedAt: number
}

/** 草稿的防抖窗口（docs/design/04 §4）。 */
const DRAFT_DEBOUNCE_MS = 500

/**
 * 不做任何副作用的默认实现。
 *
 * 单元测试里绝大多数用例不关心监听和草稿，让它们各自造一份桩太吵；
 * 而真要验这两件事的用例会显式传进来。
 */
const NO_SIDE_EFFECTS: DocumentSideEffects = {
  async watch() {},
  async writeDraft() {},
  async dropDraft() {},
}

export interface DocumentState {
  path: string | null
  name: string
  dirty: boolean
  readOnly: boolean
  /** 文件已被外部删除；保存时会重新创建（docs/design/04 §8）。 */
  deleted: boolean
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
  /** 文件在磁盘上被删掉了 —— 缓冲区里的内容此刻是唯一一份。 */
  private externallyDeleted = false

  private draftTimer: ReturnType<typeof setTimeout> | null = null
  /** 本窗口的草稿 key。未命名文档也要有一个稳定的 key，否则每次写都新建一份。 */
  private readonly draftKey: string

  constructor(
    private readonly host: HostBridge,
    private readonly editor: EditorHandle,
    private readonly onChange: (state: DocumentState) => void,
    private readonly effects: DocumentSideEffects = NO_SIDE_EFFECTS,
    windowKey = 'window',
  ) {
    this.draftKey = `untitled:${windowKey}`
  }

  state(): DocumentState {
    return {
      path: this.filePath,
      name: this.filePath ? basename(this.filePath) : UNTITLED,
      dirty: this.isDirty(),
      readOnly: this.readOnly,
      deleted: this.externallyDeleted,
      meta: this.meta,
    }
  }

  isDirty(): boolean {
    return this.editor.getDoc() !== this.savedText
  }

  /**
   * 当前窗口是否为「空白未命名文档」。
   *
   * 「打开文件」用它决定是就地打开还是另开窗口 —— 见 docs/adr/0005 §关键推论 3。
   */
  isEmptyUntitled(): boolean {
    return this.filePath === null && !this.isDirty()
  }

  private emit(): void {
    this.onChange(this.state())
  }

  /** 内容变化时由编辑器回调，用于刷新脏标记与草稿。 */
  notifyEdited(): void {
    this.emit()
    this.scheduleDraft()
  }

  /**
   * 防抖写草稿。
   *
   * 干净的文档不写草稿 —— 磁盘上已经有一份一模一样的了，
   * 写了只会让下次启动提示恢复一份毫无差别的内容。
   */
  private scheduleDraft(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null
      void this.flushDraft()
    }, DRAFT_DEBOUNCE_MS)
  }

  private async flushDraft(): Promise<void> {
    const key = this.currentDraftKey()
    if (!this.isDirty()) {
      await this.effects.dropDraft(key)
      return
    }
    await this.effects.writeDraft(key, this.editor.getDoc(), {
      path: this.filePath,
      baselineHash: this.baselineHash,
      savedAt: Date.now(),
    })
  }

  private currentDraftKey(): string {
    return this.filePath ?? this.draftKey
  }

  async newFile(): Promise<void> {
    if (!(await this.confirmDiscard())) return
    this.filePath = null
    this.meta = { ...DEFAULT_META }
    this.baselineHash = null
    this.savedText = ''
    this.readOnly = false
    this.externallyDeleted = false
    this.editor.setDoc('', { readOnly: false })
    this.emit()
    await this.effects.watch(null)
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
      this.externallyDeleted = false
      this.editor.setDoc(result.text, { readOnly: result.readOnly })
      this.emit()
      await this.effects.watch(target)

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
    const previousKey = this.currentDraftKey()
    const ok = await this.writeTo(target, null)
    if (ok) {
      this.filePath = target
      this.readOnly = false
      this.emit()
      // 换了落脚点：旧草稿（很可能是未命名那份）连同旧监听一起撤掉
      await this.effects.dropDraft(previousKey)
      await this.effects.watch(target)
    }
    return ok
  }

  private async writeTo(target: string, expectedHash: string | null): Promise<boolean> {
    const text = this.editor.getDoc()
    try {
      const result = await this.host.fs.write(target, text, { meta: this.meta, expectedHash })
      this.baselineHash = result.hash
      this.savedText = text
      // 写成功 == 文件此刻确实存在，「已删除」标记就该摘掉
      this.externallyDeleted = false
      this.emit()
      // 正常保存之后立刻删草稿：留着的话下次启动会提示恢复一份和磁盘
      // 一模一样的内容，用户会以为自己丢过东西
      await this.effects.dropDraft(this.currentDraftKey())
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

  /**
   * 磁盘上的文件被外部程序改了（docs/design/04 §3 的决策树）。
   *
   * ```
   *              编辑器有未保存改动？
   *                     │
   *        ┌────────────┴────────────┐
   *       否                         是
   *        │                          │
   *  直接重载，不打扰用户        弹冲突对话框，绝不自动选边
   * ```
   *
   * 「没有未保存改动就直接重载」这条很关键：`git checkout`、外部格式化工具、
   * 云盘同步都会改文件，而这些场景下用户什么都没输入 —— 弹一个「文件被改了，
   * 要重载吗」除了打断他没有别的作用。**没有任何东西会丢，就不该问。**
   *
   * 反过来，一旦有未保存改动，两边都是真内容，编辑器没有资格替用户选。
   */
  async handleExternalChange(hash: string | null, deleted: boolean): Promise<void> {
    if (!this.filePath) return
    // 内容跟基线一致 —— 别的程序碰了文件但没改内容（touch、权限变更）
    if (!deleted && hash !== null && hash === this.baselineHash) return

    if (deleted) {
      // 文件没了不能自动做任何事：缓冲区里的内容此刻成了唯一一份，
      // 重载会把它抹掉。标记成「已删除」，让保存走另存为流程（04 §8）
      this.baselineHash = null
      this.externallyDeleted = true
      this.emit()
      await this.host.dialog.message({
        message: '文件已被删除或移动',
        detail: '编辑器里的内容还在。下次保存会重新创建这个文件。',
      })
      return
    }

    if (!this.isDirty()) {
      await this.reloadFromDisk()
      return
    }

    const choice = await this.host.dialog.confirm({
      message: `「${this.state().name}」已被其他程序修改`,
      detail: '你这边也有未保存的修改。要保留哪一份？',
      buttons: ['保留我的修改', '用磁盘上的内容'],
      defaultId: 0,
      cancelId: 0,
    })

    if (choice === 1) await this.reloadFromDisk()
    // 保留我的：什么都不做。基线故意**不更新** —— 下次保存时会撞上冲突检测，
    // 用户在那里再确认一次覆盖。这是最后一道防线，不能因为「他刚才说了保留我的」
    // 就把它拆掉
  }

  /**
   * 把一份草稿装回编辑器（崩溃恢复，docs/design/04 §4）。
   *
   * 有原文件的话**先读原文件建立基线**，再把草稿内容盖上去 —— 这样文档立刻
   * 处于「已打开 + 脏」的状态，用户按一次 ⌘S 就落盘，且冲突检测照常生效。
   * 直接把草稿当成文件内容装进去是错的：基线会等于草稿，
   * 于是「磁盘上其实还是旧内容」这件事再也没人知道。
   */
  async restoreDraft(text: string, target: string | null): Promise<void> {
    if (target) {
      await this.openPath(target, { alreadyConfirmed: true })
      // 打不开（文件被删了）就退化成一份未命名文档，内容仍然保住
      if (this.filePath !== target) {
        this.filePath = null
        this.baselineHash = null
        this.savedText = ''
      }
    }
    this.editor.replaceDoc(text)
    this.emit()
  }

  private async reloadFromDisk(): Promise<void> {
    if (!this.filePath) return
    try {
      const result = await this.host.fs.read(this.filePath)
      this.meta = result.meta
      this.baselineHash = result.hash
      this.savedText = result.text
      this.readOnly = result.readOnly
      this.externallyDeleted = false
      // replaceDoc 而不是 setDoc：保留撤销栈与光标位置，
      // 用户还能把自己的版本撤回来（04 §3 要求「保留光标位置与滚动位置」）
      this.editor.replaceDoc(result.text)
      this.emit()
    } catch (error) {
      await this.host.dialog.message({
        message: '重新载入失败',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
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
