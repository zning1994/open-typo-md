/**
 * 文件树（docs/design/04 §2）。
 *
 * 跟大纲、命令面板一样是裸 DOM（理由见 palette.ts）。这一层刻意**没有**
 * 引入 React —— 见路线图里 M4.5 #2 的偏差说明。
 *
 * ## 只读的导航视图
 *
 * 点一下在标签里打开，仅此而已。不提供重命名、拖拽移动、新建、删除 ——
 * 那些是**文件系统的写操作**，每一条都要处理「目标已存在」「正开着的文件被移走」
 * 「权限不足」「操作到一半失败」，而且每一条都可能不可逆。
 * 它们该是一批单独的工作，不是文件树顺手带出来的赠品。
 *
 * ## 懒展开，不监听目录
 *
 * 展开时才读那一层。一次性递归整棵树在大仓库上要几秒钟，而用户通常只看两三层。
 *
 * 目录**不监听**：递归 inotify 在大仓库上直接爆句柄上限，换来的只是
 * 「别人在别处新建了文件、树里自动多一行」。所以给了刷新按钮，没给监听
 * （见 main/watcher.ts 的说明）。
 */
import type { DirEntry } from '@typo/plugin-api'

export interface FileTreeOptions {
  list: (dir: string) => Promise<DirEntry[]>
  /** 在标签里打开某个文件。 */
  open: (path: string) => void
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

/** 目录在前，同类按名字排。用 zh 排序规则 —— 中文文件名按拼音才符合直觉。 */
function compare(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name, 'zh')
}

function basename(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return index === -1 ? filePath : filePath.slice(index + 1)
}

export class FileTreePanel {
  private readonly root: HTMLElement
  private readonly title: HTMLElement
  private readonly list: HTMLElement
  private folderPath: string | null = null
  /** 已经展开的目录。刷新时靠它把树恢复成原来的形状。 */
  private readonly expanded = new Set<string>()
  private activePath: string | null = null

  constructor(
    host: HTMLElement,
    private readonly options: FileTreeOptions,
  ) {
    this.root = document.createElement('aside')
    this.root.className = 'typo-files'
    this.root.hidden = true

    const header = document.createElement('div')
    header.className = 'typo-files__header'

    this.title = document.createElement('span')
    this.title.className = 'typo-files__title'
    header.appendChild(this.title)

    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'typo-files__refresh'
    refresh.textContent = '↻'
    refresh.title = '刷新'
    refresh.setAttribute('aria-label', '刷新文件树')
    refresh.addEventListener('click', () => void this.refresh())
    header.appendChild(refresh)

    this.root.appendChild(header)

    this.list = document.createElement('div')
    this.list.className = 'typo-files__list'
    this.list.setAttribute('role', 'tree')
    this.root.appendChild(this.list)

    this.list.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const node = target.closest<HTMLElement>('[data-path]')
      if (!node) return
      const path = node.dataset['path'] as string
      if (node.dataset['kind'] === 'directory') void this.toggleDir(path)
      else this.options.open(path)
    })

    host.appendChild(this.root)
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
    this.title.textContent = basename(dir) || dir
    this.title.title = dir
    this.root.hidden = false
    await this.refresh()
    this.options.onFolderChange()
  }

  closeFolder(): void {
    this.folderPath = null
    this.expanded.clear()
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
      return [this.makeMessage('读不出这个目录', depth)]
    }
    entries.sort(compare)

    const nodes: HTMLElement[] = []
    for (const entry of entries) {
      nodes.push(this.makeNode(entry, depth))
      if (entry.kind === 'directory' && this.expanded.has(entry.path)) {
        nodes.push(...(await this.renderLevel(entry.path, depth + 1)))
      }
    }
    if (nodes.length === 0) nodes.push(this.makeMessage('空目录', depth))
    return nodes
  }

  private makeNode(entry: DirEntry, depth: number): HTMLElement {
    const node = document.createElement('div')
    const isDir = entry.kind === 'directory'
    node.className = `typo-files__item typo-files__item--${entry.kind}`
    node.dataset['path'] = entry.path
    node.dataset['kind'] = entry.kind
    node.setAttribute('role', 'treeitem')
    node.style.paddingLeft = `${8 + depth * 14}px`
    if (isDir) node.setAttribute('aria-expanded', String(this.expanded.has(entry.path)))

    const arrow = document.createElement('span')
    arrow.className = 'typo-files__arrow'
    arrow.textContent = isDir ? (this.expanded.has(entry.path) ? '▾' : '▸') : ''
    node.appendChild(arrow)

    const label = document.createElement('span')
    label.className = 'typo-files__name'
    label.textContent = entry.name
    node.appendChild(label)

    return node
  }

  private makeMessage(text: string, depth: number): HTMLElement {
    const node = document.createElement('div')
    node.className = 'typo-files__empty'
    node.style.paddingLeft = `${8 + depth * 14}px`
    node.textContent = text
    return node
  }
}
