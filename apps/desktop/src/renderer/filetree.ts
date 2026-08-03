/**
 * 文件树（docs/design/04 §2）。
 *
 * 跟大纲、命令面板一样是裸 DOM（理由见 palette.ts）。这一层刻意**没有**
 * 引入 React —— 见路线图里 M4.5 #2 的偏差说明。
 *
 * ## 从只读导航变成工作区入口（issue #36）
 *
 * 原来这里只能看和打开，注释上写着「重命名 / 新建 / 删除是文件系统的写操作，
 * 该是一批单独的工作」。那批工作就是这一次：
 *
 * - 主标签显示文档的**第一个标题**，没有标题才回退到文件名；
 * - 右键菜单：打开 / 新标签页打开 / 重命名 / 移到废纸篓 / 复制路径 / 在文件夹中显示；
 * - 文件夹上还能新建 Markdown 文件与子目录；
 * - 顶部有过滤框和排序切换。
 *
 * **三条写操作的安全边界不在这里，在 main**：`assertWritableInWorkspace`
 * 只认工作区根的子树且拒绝根自身。这一层画出来的菜单只是**先一步**把做不了的
 * 事藏掉（比如根上不显示「移到废纸篓」），不是防线。
 *
 * ## 标题的取法：批量、异步、失败即回退
 *
 * 标题要读文件，而文件树一层可能有几十个条目。所以：先用文件名把树画出来，
 * 再批量问一次标题，回来了就地替换。**不等标题**——等的话展开一个目录会先白
 * 一下，而那正是用户最没耐心的一刻。
 *
 * 一个目录的标题只取一次，缓存在 `titles` 里。刷新时按路径失效。
 *
 * ## 懒展开，不监听目录
 *
 * 展开时才读那一层。一次性递归整棵树在大仓库上要几秒钟，而用户通常只看两三层。
 *
 * 目录**不监听**：递归 inotify 在大仓库上直接爆句柄上限，换来的只是
 * 「别人在别处新建了文件、树里自动多一行」。所以给了刷新按钮，没给监听
 * （见 main/watcher.ts 的说明）。自己做的改动走 `refresh()` 立刻反映。
 */
import type { DirEntry } from '@mosu/plugin-api'
import type { ContextMenuResult } from '../shared/channels.js'
import { currentLocale, t } from './i18n.js'

export type TreeSort = 'name' | 'mtime'

export interface FileTreeOptions {
  list: (dir: string) => Promise<DirEntry[]>
  /** 批量取文档标题；取不到的给 null。 */
  titles: (paths: readonly string[]) => Promise<Record<string, string | null>>
  /** 在标签里打开某个文件。 */
  open: (path: string) => void
  /** 在**新**标签里打开。 */
  openInNewTab: (path: string) => void
  /** 弹右键菜单，返回用户选的那一项。 */
  contextMenu: (
    path: string,
    entry: 'file' | 'directory',
    isRoot: boolean,
  ) => Promise<ContextMenuResult>
  createFile: (dir: string, name: string) => Promise<string>
  createDirectory: (dir: string, name: string) => Promise<string>
  rename: (target: string, newName: string) => Promise<string>
  trash: (target: string) => Promise<void>
  /** 让用户确认一次（移到废纸篓）。返回 true 表示继续。 */
  confirm: (message: string, detail: string) => Promise<boolean>
  /** 操作失败时给用户看的提示。 */
  reportError: (message: string) => void
  /** 某个路径不在了 —— 已打开的标签要跟着处理。 */
  onPathGone: (path: string) => void
  /** 某个路径改名了（旧 → 新）。 */
  onPathMoved: (from: string, to: string) => void
  /** 工作区变了 —— 会话要跟着更新。 */
  onFolderChange: () => void
}

/**
 * 不进树的东西。
 *
 * 点文件都是工具的配置目录，`node_modules` 之类是量级问题 —— 一个前端仓库
 * 展开它会有几万个条目，把树变成一份没法用的滚动列表。
 */
const HIDDEN_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', '.DS_Store'])

function isHidden(entry: DirEntry): boolean {
  return entry.name.startsWith('.') || HIDDEN_DIRS.has(entry.name)
}

/** 只有 Markdown 才去读标题 —— 别的文件里没有「第一个标题」这个概念。 */
const MARKDOWN = /\.(md|markdown|mdown|mkd|mdx)$/i

function isMarkdown(entry: DirEntry): boolean {
  return entry.kind === 'file' && MARKDOWN.test(entry.name)
}

function basename(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return index === -1 ? filePath : filePath.slice(index + 1)
}

export class FileTreePanel {
  private readonly root: HTMLElement
  private readonly title: HTMLElement
  private readonly refreshButton: HTMLButtonElement
  private readonly sortButton: HTMLButtonElement
  private readonly filterInput: HTMLInputElement
  private readonly list: HTMLElement
  private folderPath: string | null = null
  /** 已经展开的目录。刷新时靠它把树恢复成原来的形状。 */
  private readonly expanded = new Set<string>()
  private activePath: string | null = null
  private sort: TreeSort = 'name'
  private filter = ''
  /** 路径 → 文档标题。null 表示「读过了，没有标题」，与「还没读」不同。 */
  private readonly titles = new Map<string, string | null>()
  /**
   * 正在原地输入的那一行。
   *
   * 同时只允许一个：两个输入框同时开着时，Esc 关掉哪一个、Enter 提交哪一个
   * 都要靠焦点去猜，而猜错的代价是把名字写到别的条目上。
   */
  private editing: { kind: 'rename' | 'new-file' | 'new-folder'; path: string } | null = null

  constructor(
    host: HTMLElement,
    private readonly options: FileTreeOptions,
  ) {
    this.root = document.createElement('aside')
    this.root.className = 'mosu-files'
    this.root.hidden = true

    const header = document.createElement('div')
    header.className = 'mosu-files__header'

    this.title = document.createElement('span')
    this.title.className = 'mosu-files__title'
    header.appendChild(this.title)

    this.sortButton = document.createElement('button')
    this.sortButton.type = 'button'
    this.sortButton.className = 'mosu-files__sort'
    this.sortButton.textContent = '⇅'
    this.sortButton.addEventListener('click', () => {
      this.sort = this.sort === 'name' ? 'mtime' : 'name'
      this.syncSortLabel()
      void this.refresh()
    })
    header.appendChild(this.sortButton)

    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'mosu-files__refresh'
    refresh.textContent = '↻'
    this.refreshButton = refresh
    refresh.addEventListener('click', () => {
      // 刷新要把标题缓存也丢掉 —— 用户按刷新多半正是因为文件在外面被改过
      this.titles.clear()
      void this.refresh()
    })
    header.appendChild(refresh)

    this.root.appendChild(header)

    this.filterInput = document.createElement('input')
    this.filterInput.type = 'search'
    this.filterInput.className = 'mosu-files__filter'
    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value.trim().toLowerCase()
      void this.refresh()
    })
    this.root.appendChild(this.filterInput)

    this.list = document.createElement('div')
    this.list.className = 'mosu-files__list'
    this.list.setAttribute('role', 'tree')
    this.root.appendChild(this.list)

    this.list.addEventListener('click', (event) => {
      const node = this.nodeOf(event.target)
      if (!node) return
      const path = node.dataset['path'] as string
      if (node.dataset['kind'] === 'directory') void this.toggleDir(path)
      else this.options.open(path)
    })

    this.list.addEventListener('contextmenu', (event) => {
      const node = this.nodeOf(event.target)
      if (!node) return
      event.preventDefault()
      void this.showMenu(
        node.dataset['path'] as string,
        node.dataset['kind'] === 'directory' ? 'directory' : 'file',
      )
    })

    this.retranslate()
    host.appendChild(this.root)
  }

  private nodeOf(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null
    // 正在编辑的那一行不响应点击 / 右键 —— 输入框自己要处理这些事件
    if (target.closest('.mosu-files__input')) return null
    return target.closest<HTMLElement>('[data-path]')
  }

  folder(): string | null {
    return this.folderPath
  }

  isOpen(): boolean {
    return !this.root.hidden
  }

  /** 打开一个工作区目录。 */
  async openFolder(dir: string): Promise<void> {
    this.folderPath = dir
    this.expanded.clear()
    this.expanded.add(dir)
    this.titles.clear()
    this.filter = ''
    this.filterInput.value = ''
    this.title.textContent = basename(dir) || dir
    this.title.title = dir
    this.root.hidden = false
    await this.refresh()
    this.options.onFolderChange()
  }

  closeFolder(): void {
    this.folderPath = null
    this.expanded.clear()
    this.titles.clear()
    this.list.replaceChildren()
    this.root.hidden = true
    this.options.onFolderChange()
  }

  /** 只切显示，不动工作区 —— 关掉面板不该让用户丢掉打开的目录。 */
  toggle(): void {
    if (!this.folderPath) return
    this.root.hidden = !this.root.hidden
  }

  /** 高亮当前正在编辑的文件。 */
  setActive(path: string | null): void {
    this.activePath = path
    for (const node of this.list.querySelectorAll<HTMLElement>('[data-path]')) {
      node.classList.toggle('is-active', node.dataset['path'] === path)
    }
  }

  /** 换语言后补上只写过一次的文案，并重画一遍树。 */
  retranslate(): void {
    this.refreshButton.title = t('panel.files.refresh')
    this.refreshButton.setAttribute('aria-label', t('panel.files.refreshLabel'))
    this.filterInput.placeholder = t('panel.files.filter')
    this.filterInput.setAttribute('aria-label', t('panel.files.filter'))
    this.syncSortLabel()
    void this.refresh()
  }

  private syncSortLabel(): void {
    const label = t(this.sort === 'name' ? 'panel.files.sortName' : 'panel.files.sortMtime')
    this.sortButton.title = label
    this.sortButton.setAttribute('aria-label', label)
  }

  async refresh(): Promise<void> {
    if (!this.folderPath) return
    const children = await this.renderLevel(this.folderPath, 0)
    this.list.replaceChildren(...children)
    this.setActive(this.activePath)
  }

  private async toggleDir(dir: string): Promise<void> {
    if (this.expanded.has(dir)) this.expanded.delete(dir)
    else this.expanded.add(dir)
    await this.refresh()
  }

  /**
   * 目录在前，同类再按当前排序规则，**按界面语言的排序规则**。
   *
   * 之前写死 `'zh'`（中文文件名按拼音才符合直觉）。现在跟着界面语言走：
   * 日文界面下假名要按五十音排，写死 zh 排出来的顺序对日文用户毫无规律。
   *
   * 按修改时间排时**目录仍然在前**：把目录和文件按时间混排，树的形状每次刷新
   * 都在变，找东西反而更慢。
   */
  private compare = (a: DirEntry, b: DirEntry): number => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    if (this.sort === 'mtime') {
      // 取不到时间的排到最后而不是最前 —— 排最前的话它会一直霸占列表顶端
      const at = a.mtimeMs ?? -Infinity
      const bt = b.mtimeMs ?? -Infinity
      if (at !== bt) return bt - at
    }
    return a.name.localeCompare(b.name, currentLocale())
  }

  /**
   * 渲染一层。展开的子目录递归下去。
   *
   * 读目录失败（权限、目录刚被删）时渲染成一个「读不出来」的条目而不是抛错：
   * 树里有一个坏目录，不该让整棵树消失（原则 P2）。
   */
  private async renderLevel(dir: string, depth: number): Promise<HTMLElement[]> {
    let entries: DirEntry[]
    try {
      entries = (await this.options.list(dir)).filter((entry) => !isHidden(entry))
    } catch {
      return [this.makeMessage(t('panel.files.unreadable'), depth)]
    }
    entries.sort(this.compare)

    // 标题异步补：先按文件名把树画出来，回来了再就地替换。
    // 等标题的话展开目录会先白一下，而那是用户最没耐心的一刻
    void this.loadTitles(entries)

    const nodes: HTMLElement[] = []
    for (const entry of entries) {
      if (!this.matchesFilter(entry)) continue
      nodes.push(this.makeNode(entry, depth))
      if (this.editing?.path === entry.path && this.editing.kind === 'rename') {
        nodes[nodes.length - 1] = this.makeInput(entry, depth)
      }
      if (entry.kind === 'directory' && this.expanded.has(entry.path)) {
        nodes.push(...(await this.renderLevel(entry.path, depth + 1)))
      }
    }

    // 「在这个目录里新建」的输入行长在该目录的最前面
    if (this.editing && this.editing.path === dir && this.editing.kind !== 'rename') {
      nodes.unshift(this.makeInput(null, depth))
    }

    if (nodes.length === 0) {
      nodes.push(
        this.makeMessage(t(this.filter ? 'panel.files.noMatch' : 'panel.files.empty'), depth),
      )
    }
    return nodes
  }

  /**
   * 过滤只作用在**文件**上。
   *
   * 目录一律保留：把不匹配的目录也藏掉的话，深处的匹配项会连同它的路径一起
   * 消失，用户看到的是一棵空树。真正的「按名字找文件」是 Quick Open 的活，
   * 这里只是把当前这棵树滤一遍。
   */
  private matchesFilter(entry: DirEntry): boolean {
    if (!this.filter) return true
    if (entry.kind === 'directory') return true
    const title = this.titles.get(entry.path)
    return (
      entry.name.toLowerCase().includes(this.filter) ||
      (title ?? '').toLowerCase().includes(this.filter)
    )
  }

  /** 批量补标题，回来之后只重画标签，不重建整棵树。 */
  private async loadTitles(entries: readonly DirEntry[]): Promise<void> {
    const wanted = entries
      .filter((entry) => isMarkdown(entry) && !this.titles.has(entry.path))
      .map((entry) => entry.path)
    if (wanted.length === 0) return

    let found: Record<string, string | null>
    try {
      found = await this.options.titles(wanted)
    } catch {
      // 标题取不到不是错误，只是没有标题可显示
      return
    }

    let changed = false
    for (const [path, title] of Object.entries(found)) {
      if (this.titles.get(path) !== title) changed = true
      this.titles.set(path, title)
    }
    if (!changed) return

    for (const node of this.list.querySelectorAll<HTMLElement>('[data-path]')) {
      const path = node.dataset['path'] as string
      if (!(path in found)) continue
      this.paintLabel(node, path, basename(path))
    }
  }

  /**
   * 把一行的标签画成「标题为主、文件名为辅」。
   *
   * 没有标题时**只显示文件名**，不显示一个空的副标签 —— 副标签的意义是
   * 「同一个标题的两份文档怎么区分」，主标签已经是文件名时它就是纯噪声。
   */
  private paintLabel(node: HTMLElement, path: string, fileName: string): void {
    const label = node.querySelector<HTMLElement>('.mosu-files__name')
    if (!label) return
    const title = this.titles.get(path)

    label.replaceChildren(document.createTextNode(title || fileName))
    node.title = title ? `${title}\n${path}` : path

    const existing = node.querySelector('.mosu-files__sub')
    existing?.remove()
    if (title) {
      const sub = document.createElement('span')
      sub.className = 'mosu-files__sub'
      sub.textContent = fileName
      node.appendChild(sub)
    }
  }

  private makeNode(entry: DirEntry, depth: number): HTMLElement {
    const node = document.createElement('div')
    const isDir = entry.kind === 'directory'
    node.className = `mosu-files__item mosu-files__item--${entry.kind}`
    node.dataset['path'] = entry.path
    node.dataset['kind'] = entry.kind
    node.setAttribute('role', 'treeitem')
    node.style.paddingLeft = `${8 + depth * 14}px`
    if (isDir) node.setAttribute('aria-expanded', String(this.expanded.has(entry.path)))

    const arrow = document.createElement('span')
    arrow.className = 'mosu-files__arrow'
    arrow.textContent = isDir ? (this.expanded.has(entry.path) ? '▾' : '▸') : ''
    node.appendChild(arrow)

    const label = document.createElement('span')
    label.className = 'mosu-files__name'
    label.textContent = entry.name
    node.appendChild(label)

    if (!isDir) this.paintLabel(node, entry.path, entry.name)
    else node.title = entry.path

    return node
  }

  /**
   * 原地输入行 —— 重命名与新建共用。
   *
   * 用输入框而不是弹对话框：Electron 没有原生 prompt，自己搭一个浮层要处理
   * 焦点、Esc、遮罩，而这件事在树上就地做完最自然，也跟 Finder / VS Code 一致。
   *
   * `entry` 为 null 表示新建。
   */
  private makeInput(entry: DirEntry | null, depth: number): HTMLElement {
    const row = document.createElement('div')
    row.className = 'mosu-files__item mosu-files__item--editing'
    row.style.paddingLeft = `${8 + depth * 14}px`

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'mosu-files__input'
    input.value = entry?.name ?? ''
    row.appendChild(input)

    let done = false
    const finish = (commit: boolean): void => {
      // blur 与 keydown 都会走到这里（Enter 提交时输入框也会失焦），
      // 少了这个闸门就会提交两次 —— 第二次必然撞名报错
      if (done) return
      done = true
      const value = input.value
      this.editing = null
      if (commit && value.trim()) void this.commitEdit(value)
      else void this.refresh()
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(false))

    // 树是刚刚才被 replaceChildren 换上去的，此刻元素还没进文档，
    // 直接 focus 不生效。挪到下一个宏任务
    setTimeout(() => {
      input.focus()
      // 重命名时只选中主名，扩展名留着 —— 改名十次有九次不动扩展名
      const dot = input.value.lastIndexOf('.')
      if (entry && entry.kind === 'file' && dot > 0) input.setSelectionRange(0, dot)
      else input.select()
    }, 0)

    return row
  }

  private async commitEdit(value: string): Promise<void> {
    const editing = this.pendingEdit
    this.pendingEdit = null
    if (!editing) return

    try {
      if (editing.kind === 'rename') {
        const to = await this.options.rename(editing.path, value)
        if (to !== editing.path) this.options.onPathMoved(editing.path, to)
      } else if (editing.kind === 'new-file') {
        const created = await this.options.createFile(editing.path, ensureMarkdown(value))
        this.titles.delete(created)
        await this.refresh()
        this.options.open(created)
        return
      } else {
        await this.options.createDirectory(editing.path, value)
      }
    } catch (error) {
      this.options.reportError(error instanceof Error ? error.message : String(error))
    }
    await this.refresh()
  }

  /**
   * `editing` 在输入框建好的那一刻就被 `finish` 清空了（它要让下一次
   * `refresh` 画回普通行），所以提交时得从这里取。两个字段而不是一个的理由：
   * 「树上还画不画输入框」和「提交的是哪一次编辑」是两件事，合并之后
   * Esc 取消会连带把提交目标也弄丢。
   */
  private pendingEdit: { kind: 'rename' | 'new-file' | 'new-folder'; path: string } | null =
    null

  private beginEdit(kind: 'rename' | 'new-file' | 'new-folder', path: string): void {
    this.editing = { kind, path }
    this.pendingEdit = { kind, path }
    if (kind !== 'rename') this.expanded.add(path)
    void this.refresh()
  }

  private async showMenu(path: string, entry: 'file' | 'directory'): Promise<void> {
    const isRoot = path === this.folderPath
    const picked = await this.options.contextMenu(path, entry, isRoot)
    switch (picked) {
      case 'tree.open':
        this.options.open(path)
        return
      case 'tree.openInNewTab':
        this.options.openInNewTab(path)
        return
      case 'tree.rename':
        this.beginEdit('rename', path)
        return
      case 'tree.newFile':
        this.beginEdit('new-file', path)
        return
      case 'tree.newFolder':
        this.beginEdit('new-folder', path)
        return
      case 'tree.trash':
        await this.doTrash(path)
        return
      default:
        return
    }
  }

  /**
   * 移到废纸篓。**问一次**再动手。
   *
   * 废纸篓是可撤销的，所以这句确认不是为了防丢数据，是为了防误点 —— 右键菜单
   * 里「重命名」和「移到废纸篓」上下挨着，而它们的后果差得很远。
   */
  private async doTrash(path: string): Promise<void> {
    const name = basename(path)
    const ok = await this.options.confirm(
      t('files.trash.confirm', { name }),
      t('files.trash.detail'),
    )
    if (!ok) return

    try {
      await this.options.trash(path)
    } catch (error) {
      this.options.reportError(error instanceof Error ? error.message : String(error))
      return
    }
    this.titles.delete(path)
    this.expanded.delete(path)
    this.options.onPathGone(path)
    await this.refresh()
  }

  private makeMessage(text: string, depth: number): HTMLElement {
    const node = document.createElement('div')
    node.className = 'mosu-files__empty'
    node.style.paddingLeft = `${8 + depth * 14}px`
    node.textContent = text
    return node
  }
}

/**
 * 新建文件时补上 `.md`。
 *
 * 只在**完全没有扩展名**时补：用户写 `笔记.txt` 是明确表达了意图，
 * 而写 `笔记` 时他要的几乎一定是 Markdown（这是个 Markdown 编辑器）。
 */
function ensureMarkdown(name: string): string {
  const trimmed = name.trim()
  return /\.[^./\\]+$/.test(trimmed) ? trimmed : `${trimmed}.md`
}
