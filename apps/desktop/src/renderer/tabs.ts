/**
 * 窗口内的标签页（docs/adr/0005）。
 *
 * ADR 里那条主线是这个文件的全部依据：
 *
 * > **窗口是文档的容器，标签是窗口内的文档列表。所有状态挂在标签上，
 * > 窗口只负责承载与聚焦。**
 *
 * 所以这里不是「一个编辑器 + 一份文本数组」，而是**每个标签一整套**
 * `TypoEditor` + `DocumentController`。撤销栈、脏标记、保真元数据、只读状态、
 * 冲突基线 —— 这些全在控制器里，共用一个编辑器的话它们必然串味：
 * 在 A 标签按撤销会倒出 B 标签的内容。
 *
 * 代价是内存随标签数线性增长（ADR §代价 已经写明）。上限策略（卸载非活跃标签
 * 的编辑器实例、只留文本与选区）留到真出现问题再做 —— 现在做属于凭想象优化。
 *
 * ## 切换靠显示与隐藏，不靠重建
 *
 * 每个标签有自己的容器，切换只改 `hidden`。重建编辑器会丢掉滚动位置、
 * 选区和撤销栈，那正好是标签页要保住的东西。
 *
 * 代价是 CodeMirror 在隐藏容器里量不到尺寸，切回来时行高与滚动会是错的 ——
 * 所以显示之后必须显式 `requestMeasure()`。
 */
import type { EditorStatus, TypoEditor } from '@typo/editor'
import type { DocumentController } from './document.js'
import { t } from './i18n.js'

export interface Tab {
  readonly id: string
  readonly page: HTMLElement
  readonly editor: TypoEditor
  readonly controller: DocumentController
}

/** 造一个标签时，管理器提供给工厂的上下文。 */
export interface TabContext {
  /** 这个标签专用的草稿 key（未命名文档也要有稳定的 key）。 */
  draftKey: string
  /** 文档内容变了。 */
  edited: () => void
  /** 编辑器状态变了（字数、光标）。 */
  status: (status: EditorStatus) => void
  /** 文档状态变了（路径、脏标记）。 */
  changed: () => void
}

export interface TabFactory {
  (
    parent: HTMLElement,
    context: TabContext,
  ): {
    editor: TypoEditor
    controller: DocumentController
  }
}

export interface TabManagerOptions {
  /** 各标签的编辑器容器都挂在它下面。 */
  container: HTMLElement
  /** 标签条。 */
  strip: HTMLElement
  /** 本窗口的稳定标识，用来拼草稿 key。 */
  windowKey: string
  create: TabFactory
  /** 标签集合或某个标签的状态变了 —— 重绘状态栏、标题、会话上报。 */
  onChange: () => void
  /** 活动标签的编辑器状态。 */
  onStatus: (status: EditorStatus) => void
  /** 活动标签的文档内容变了（大纲要刷新）。 */
  onDocChange: () => void
  /** 弹确认框。只用这一件事，没必要把整个 HostBridge 传进来。 */
  confirm: (options: {
    message: string
    detail?: string
    buttons: string[]
    defaultId?: number
    cancelId?: number
  }) => Promise<number>
  /** 文件还在不在 —— 会话恢复时用来跳过已经不存在的文件。 */
  exists: (path: string) => Promise<boolean>
}

/** 标签条上显示的信息。 */
export interface TabView {
  id: string
  name: string
  path: string | null
  dirty: boolean
  active: boolean
}

let nextTabSeq = 1

export class TabManager {
  private readonly tabs: Tab[] = []
  private activeId: string | null = null

  constructor(private readonly options: TabManagerOptions) {
    this.options.strip.addEventListener('click', (event) => this.onStripClick(event))
    // 中键关标签是浏览器与各家编辑器的通行手势，成本几乎为零
    this.options.strip.addEventListener('auxclick', (event) => {
      if (event.button === 1) this.onStripClick(event)
    })
  }

  private onStripClick(event: MouseEvent): void {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const closer = target.closest<HTMLElement>('[data-close]')
    if (closer) {
      event.preventDefault()
      void this.close(closer.dataset['close'] as string)
      return
    }
    const tab = target.closest<HTMLElement>('[data-tab]')
    if (!tab) return
    if (event.button === 1) {
      void this.close(tab.dataset['tab'] as string)
      return
    }
    this.activate(tab.dataset['tab'] as string)
  }

  /** 活动标签。永远至少有一个 —— 关掉最后一个时会立刻补一个空白标签。 */
  active(): Tab {
    const found = this.tabs.find((tab) => tab.id === this.activeId)
    if (found) return found
    return this.open()
  }

  /** 换语言后重画标签条 —— 未保存标记的提示文字和关闭按钮的 aria-label 在里面。 */
  retranslate(): void {
    this.render()
  }

  all(): readonly Tab[] {
    return this.tabs
  }

  views(): TabView[] {
    return this.tabs.map((tab) => {
      const state = tab.controller.state()
      return {
        id: tab.id,
        name: state.name,
        path: state.path,
        dirty: state.dirty,
        active: tab.id === this.activeId,
      }
    })
  }

  /** 新建一个空白标签并切过去。 */
  open(): Tab {
    const id = `tab-${nextTabSeq++}`
    const page = document.createElement('div')
    page.className = 'tab-page'
    page.dataset['page'] = id
    this.options.container.appendChild(page)

    const { editor, controller } = this.options.create(page, {
      draftKey: `untitled:${this.options.windowKey}:${id}`,
      edited: () => {
        if (id === this.activeId) this.options.onDocChange()
      },
      status: (status) => {
        if (id === this.activeId) this.options.onStatus(status)
      },
      changed: () => this.render(),
    })

    const tab: Tab = { id, page, editor, controller }
    this.tabs.push(tab)
    this.activate(id)
    return tab
  }

  activate(id: string): void {
    if (!this.tabs.some((tab) => tab.id === id)) return
    this.activeId = id
    for (const tab of this.tabs) tab.page.hidden = tab.id !== id
    this.render()

    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    // 隐藏期间量不到尺寸，不重新量的话行高与滚动位置都是错的
    tab.editor.view.requestMeasure()
    tab.editor.focus()
    this.options.onStatus(tab.editor.status())
    this.options.onDocChange()
  }

  /**
   * 打开一个文件。落点规则见 docs/adr/0005 §关键推论 3，外加一条：
   *
   * **已经开着的文件不再开第二个标签**，直接切过去。同一个文件两个标签各有
   * 一份撤销栈和脏标记，保存时必然互相覆盖 —— 那是数据丢失，不是便利。
   */
  async openPath(target: string): Promise<void> {
    const existing = this.tabs.find((tab) => tab.controller.state().path === target)
    if (existing) {
      this.activate(existing.id)
      return
    }

    const current = this.tabs.find((tab) => tab.id === this.activeId)
    const reuse = current && current.controller.isEmptyUntitled() ? current : this.open()
    this.activate(reuse.id)
    await reuse.controller.openPath(target, { alreadyConfirmed: true })
    this.render()
  }

  /**
   * 关掉一个标签。
   *
   * 关掉最后一个标签不等于关窗口 —— 补一个空白标签。「窗口里一个文档都没有」
   * 是个没有意义的状态：状态栏、菜单、导出全都没有作用对象。
   */
  async close(id: string): Promise<void> {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const tab = this.tabs[index] as Tab
    if (!(await tab.controller.canClose())) return

    this.tabs.splice(index, 1)
    tab.editor.destroy()
    tab.page.remove()

    if (this.tabs.length === 0) {
      this.activeId = null
      this.open()
      return
    }
    if (this.activeId === id) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)] as Tab
      this.activate(next.id)
    } else {
      this.render()
    }
  }

  /** 往后 / 往前切一个标签，到头绕回去。 */
  cycle(delta: 1 | -1): void {
    if (this.tabs.length < 2) return
    const index = this.tabs.findIndex((tab) => tab.id === this.activeId)
    const next = (index + delta + this.tabs.length) % this.tabs.length
    this.activate((this.tabs[next] as Tab).id)
  }

  /** 把外部文件变更通知转给对应的标签。 */
  async notifyExternalChange(
    path: string,
    hash: string | null,
    deleted: boolean,
  ): Promise<void> {
    const tab = this.tabs.find((t) => t.controller.state().path === path)
    if (!tab) return
    await tab.controller.handleExternalChange(hash, deleted)
  }

  /** 当前所有标签的文件路径（未命名的除外），供文件监听用。 */
  paths(): string[] {
    return this.tabs
      .map((tab) => tab.controller.state().path)
      .filter((path): path is string => path !== null)
  }

  /**
   * 窗口关闭前的确认（docs/adr/0005 §关键推论 4）。
   *
   * **按标签汇总，不逐个弹窗。** 三个脏标签连弹三次对话框，用户会以为程序卡了；
   * 而且他在第三个框上点「取消」时，前两个已经存下去了 —— 取消了个寂寞。
   */
  async canCloseWindow(): Promise<boolean> {
    const dirty = this.tabs.filter((tab) => tab.controller.isDirty())
    if (dirty.length === 0) return true
    // 只有一个时沿用单文档的措辞（「是否保存对『x』的修改？」），更具体
    if (dirty.length === 1) return (dirty[0] as Tab).controller.canClose()

    const names = dirty.map((tab) => tab.controller.state().name).join('\n')
    const choice = await this.options.confirm({
      message: t('tabs.closeAll.title', { count: dirty.length }),
      detail: t('tabs.closeAll.detail', { names }),
      buttons: [t('tabs.closeAll.saveAll'), t('tabs.closeAll.discardAll'), t('dialog.cancel')],
      defaultId: 0,
      cancelId: 2,
    })

    if (choice === 2) return false
    if (choice === 1) return true
    for (const tab of dirty) {
      // 任何一个存不下去（只读、磁盘满、用户在另存为里取消）就整个中止 ——
      // 继续关下去等于把它悄悄丢了
      if (!(await tab.controller.save())) return false
    }
    return true
  }

  /** 会话快照：只记已经落盘的文件（未命名标签没有可恢复的落点）。 */
  snapshot(): { tabs: string[]; active: number } {
    const paths = this.paths()
    const activePath = this.tabs
      .find((tab) => tab.id === this.activeId)
      ?.controller.state().path
    const active = activePath ? paths.indexOf(activePath) : -1
    return { tabs: paths, active: Math.max(0, active) }
  }

  /**
   * 按会话恢复标签。
   *
   * 打不开的（文件被删了 / 移走了）**静默跳过** —— 上次会话里的某个文件不在了
   * 是很正常的事，为它弹一个错误框只会挡住启动。剩下的照常恢复。
   */
  async restore(paths: readonly string[], active: number): Promise<void> {
    for (const path of paths) {
      if (!(await this.options.exists(path))) continue
      await this.openPath(path)
    }
    const target = this.tabs[active]
    if (target) this.activate(target.id)
  }

  private render(): void {
    const strip = this.options.strip
    // 只有一个标签时不占那一条 —— 单文档场景不该为标签页付出一行高度
    strip.hidden = this.tabs.length < 2
    strip.replaceChildren(
      ...this.views().map((view) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = `tab${view.active ? ' is-active' : ''}${view.dirty ? ' is-dirty' : ''}`
        button.dataset['tab'] = view.id
        button.title = view.path ?? t('tabs.dirty')
        button.setAttribute('aria-selected', String(view.active))

        const label = document.createElement('span')
        label.className = 'tab__label'
        label.textContent = `${view.dirty ? '● ' : ''}${view.name}`
        button.appendChild(label)

        const close = document.createElement('span')
        close.className = 'tab__close'
        close.dataset['close'] = view.id
        close.setAttribute('role', 'button')
        close.setAttribute('aria-label', t('tabs.close', { name: view.name }))
        close.textContent = '×'
        button.appendChild(close)

        return button
      }),
    )
    this.options.onChange()
  }
}
