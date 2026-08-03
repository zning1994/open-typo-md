/**
 * 文档控制器：打开、保存、脏标记、冲突处理。
 *
 * 刻意做成不依赖 DOM 的纯逻辑类（只依赖 HostBridge 和一个极小的编辑器接口），
 * 这样 04 号文档里那些「必须有的防灾测试」可以用内存 HostBridge 直接跑，
 * 不需要启动 Electron。
 */
import type { HostBridge, TextFileMeta } from '@mosu/plugin-api'
import { t } from './i18n.js'

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

/**
 * 未命名文档的名字。
 *
 * **必须是函数**，不能是模块级常量：模块求值发生在语言从磁盘读回来之前，
 * 存成常量的话未命名标签会永远停在启动时那一份文案上。
 */
const untitled = (): string => t('doc.untitled')

const DEFAULT_META: TextFileMeta = { encoding: 'utf8', eol: 'lf', mixedEol: false }

/**
 * 打不开文件时给用户看的原因。
 *
 * `UnsupportedEncodingError` 的消息是 `@mosu/plugin-api` 里写死的中文 ——
 * 那一层是 i18n 够不着的（它比文案层还低，也不该认识文案层）。所以在这里按
 * **错误类型**换成本地化的说法，而不是把 IPC 传过来的 message 直接贴出去。
 *
 * 其余错误仍然原样显示：它们是文件系统给的（权限、路径太长），
 * 系统自己的措辞比我们转述一遍更准。
 */
function openFailureDetail(error: unknown, path: string): string {
  if (error instanceof Error && error.name === 'UnsupportedEncodingError') {
    return t('error.unsupportedEncoding', { path })
  }
  return error instanceof Error ? error.message : String(error)
}

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
      name: this.filePath ? basename(this.filePath) : untitled(),
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

  /**
   * 这个文档在磁盘上被**我们自己**改名了（文件树的重命名，issue #36）。
   *
   * 只换路径，**不重新读盘**：缓冲区、撤销栈、脏标记、冲突基线全部原样留着。
   * 重读一遍会把用户未保存的修改冲掉，而改名从来不该有这个后果。
   *
   * 也**不能**放着不管：路径不换的话，监听还盯着一个已经不存在的路径（于是
   * 立刻收到一条「文件被删了」），下一次保存也会把内容写回旧名字 ——
   * 磁盘上凭空多出一份旧文件。
   */
  async notePathMoved(from: string, to: string): Promise<void> {
    if (this.filePath !== from) return
    const previousKey = this.currentDraftKey()
    this.filePath = to
    this.externallyDeleted = false
    this.emit()
    // 草稿是按路径存的，改名之后旧那份认领不回来了
    await this.effects.dropDraft(previousKey)
    await this.effects.watch(to)
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
          message: t('doc.mixedEol.title'),
          detail: t('doc.mixedEol.detail', { eol: result.meta.eol === 'crlf' ? 'CRLF' : 'LF' }),
        })
      }
      if (result.readOnly) {
        await this.host.dialog.message({
          message: t('doc.readonly.title'),
          detail: t('doc.readonly.detail'),
        })
      }
    } catch (error) {
      await this.host.dialog.message({
        message: t('doc.openFailed.title'),
        detail: openFailureDetail(error, target),
      })
    }
  }

  /** @returns 是否真的保存了 */
  async save(): Promise<boolean> {
    if (!this.filePath) return this.saveAs()
    if (this.readOnly) {
      await this.host.dialog.message({
        message: t('doc.saveReadonly.title'),
        detail: t('doc.saveReadonly.detail'),
      })
      return false
    }
    return this.writeTo(this.filePath, this.baselineHash)
  }

  async saveAs(): Promise<boolean> {
    const target = await this.host.dialog.saveFile({
      defaultPath: this.filePath ?? untitled(),
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
      const result = await this.host.fs.write(target, text, {
        meta: this.meta,
        expectedHash,
        // 基线为 null 有两种来路：真的是新文件，或者文件被外部删了
        // （`handleExternalChange` 把基线清成了 null）。后者要多确认一次 ——
        // 文件可能已经回来了，那时静默覆盖就是数据丢失
        expectMissing: expectedHash === null && this.externallyDeleted,
      })
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
        message: t('doc.saveFailed.title'),
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
      message: t('doc.conflict.title'),
      detail: t('doc.conflict.detail'),
      buttons: [t('doc.conflict.overwrite'), t('doc.conflict.reload'), t('dialog.cancel')],
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
        message: t('doc.deleted.title'),
        detail: t('doc.deleted.detail'),
      })
      return
    }

    if (!this.isDirty()) {
      await this.reloadFromDisk()
      return
    }

    const choice = await this.host.dialog.confirm({
      message: t('doc.externalChange.title', { name: this.state().name }),
      detail: t('doc.externalChange.detail'),
      buttons: [t('doc.externalChange.keepMine'), t('doc.externalChange.useDisk')],
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
   * 有原文件的话先读原文件，再把草稿内容盖上去 —— 这样文档立刻处于
   * 「已打开 + 脏」的状态，用户按一次 ⌘S 就落盘。
   *
   * ## 基线必须用**草稿记下的那个**，不能用刚读到的磁盘 hash
   *
   * 这是一个静默数据丢失的洞。`openPath` 会把 `baselineHash` 设成**磁盘此刻**
   * 的 hash；如果停机期间文件在别处变过（`git pull`、云盘同步、另一个编辑器），
   * 那个新内容就成了基线，于是后续保存**跳过冲突检测直接覆盖**，一句提示都没有。
   *
   * 而完全相同的冲突在应用正常运行时是**会**弹框的 —— 差别只在中间有没有崩溃。
   * 崩溃恢复恰恰是磁盘最可能已经变了的时刻（重启前顺手 `git pull` 很自然）。
   *
   * 草稿从一开始就**正确记录了**崩溃前的基线（`drafts.ts` 的 `DraftMeta`），
   * 只是从来没人读过它 —— 写了，没读。现在把它透传进来。
   *
   * 传 null 表示这份草稿没有基线（未命名文档，或旧版本写的草稿）。
   * 那时退回原来的行为：以磁盘为基线。**不能退化成「拒绝保存」** ——
   * 用户的内容还在编辑器里，保住它比守住一次冲突检测重要。
   */
  async restoreDraft(
    text: string,
    target: string | null,
    baselineHash: string | null = null,
  ): Promise<void> {
    if (target) {
      await this.openPath(target, { alreadyConfirmed: true })
      // 打不开（文件被删了）就退化成一份未命名文档，内容仍然保住
      if (this.filePath !== target) {
        this.filePath = null
        this.baselineHash = null
        this.savedText = ''
      } else if (baselineHash !== null) {
        // 关键的一行：把基线拨回崩溃前那一刻。磁盘此刻若已不同，
        // 下一次保存就会走到既有的冲突提示分支。
        //
        // 旧版本写的草稿里没有这个字段（`baselineHash` 是后加的，而
        // `drafts.ts` 里那个 `as DraftMeta` 是不检查的断言），传进来是
        // `undefined` —— 默认值 `= null` 正好接住它，落到下面的「无基线」
        // 分支，退回原行为。
        this.baselineHash = baselineHash
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
        message: t('doc.reloadFailed.title'),
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** @returns 是否可以继续（丢弃或已保存） */
  private async confirmDiscard(): Promise<boolean> {
    if (!this.isDirty()) return true
    const choice = await this.host.dialog.confirm({
      message: t('doc.close.title', { name: this.state().name }),
      detail: t('doc.close.detail'),
      buttons: [t('doc.close.save'), t('doc.close.discard'), t('dialog.cancel')],
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
