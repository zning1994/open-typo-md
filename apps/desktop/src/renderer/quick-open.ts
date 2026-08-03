/**
 * Quick Open —— 按名字或标题直接跳到文档（issue #37）。
 *
 * ## 跟命令面板的分工
 *
 * **命令面板找动作，Quick Open 找内容。** 报告里的原话是「输入 03-mock，
 * 结果是『没有匹配的命令』」—— 两件事挤在一个入口里，用户每次都要先想
 * 「我要找的是个命令还是个文件」，而那从来不是他脑子里的问题。
 *
 * 所以是**两个面板**，不是给命令面板加一类结果。共用的只有交互约定
 * （上下键循环、Enter 执行、Esc 与点遮罩都能关、关掉后焦点回编辑器）
 * 和模糊匹配函数，那些在 palette.ts / commands.ts 里。
 *
 * **类名不共用**，样式靠 CSS 分组选择器共享。第一版图省事挂了
 * `class="mosu-palette mosu-quickopen"`，结果是既有用例里那几十个
 * `.mosu-palette__input` 一下匹配到两个元素，Playwright 的严格模式全线报错 ——
 * 而那些用例说的是「命令面板」，它们没写错。共用类名等于把「命令面板」
 * 这个名字偷偷改成了「任意一个面板」。
 *
 * ## 三类候选，排序是有讲究的
 *
 * 1. **已打开的标签** —— 排最前。用户十次里有七次是想回到刚才那篇。
 * 2. **工作区文件** —— 文件名、相对路径、文档标题都参与匹配。
 * 3. 没打开工作区时只剩第 1 类，面板照样能用。
 *
 * 同一个文件既是打开的标签又在工作区里，**只出现一次**（按路径去重）——
 * 列表里出现两行一模一样的东西，用户会以为自己看错了。
 *
 * ## 清单什么时候取
 *
 * 每次打开面板时取一遍，不常驻缓存。工作区不监听目录（04 §1.1），常驻缓存
 * 意味着「刚在别处新建的文件搜不到」，而用户不会知道要去按刷新。
 * 一次遍历在几千份文档上是几十毫秒，值得。
 */
import { fuzzyMatch, scoreOf } from './commands.js'
import { t } from './i18n.js'
import type { WorkspaceFile } from '../shared/channels.js'

export interface QuickOpenEntry {
  path: string
  /** 主标签：文档标题，没有就是文件名。 */
  label: string
  /** 副标签：相对路径。 */
  detail: string
  /** 已经开着的标签 —— 排最前，并且标出来。 */
  open: boolean
}

export interface QuickOpenOptions {
  /** 当前工作区根；没打开工作区时给 null。 */
  workspace: () => string | null
  walk: (root: string) => Promise<{ files: WorkspaceFile[]; truncated: boolean }>
  titles: (paths: readonly string[]) => Promise<Record<string, string | null>>
  /** 当前开着的标签（路径 → 显示名）。 */
  openTabs: () => { path: string; label: string }[]
  open: (path: string) => void
  openInNewTab: (path: string) => void
  restoreFocus: () => void
}

/**
 * 打分：标题 / 文件名的命中比路径的命中值钱。
 *
 * 路径也参与匹配是必要的（`docs/design/02` 这种输入很自然），但如果不压低它的
 * 权重，搜 `design` 会把那个目录下的**每一份**文档都以同样的分数列出来，
 * 而用户想要的是名字里带 design 的那个。
 */
const LABEL_BONUS = 40
const NAME_BONUS = 20
const OPEN_BONUS = 60

interface Scored {
  entry: QuickOpenEntry
  hits: number[]
  score: number
}

export function searchEntries(entries: readonly QuickOpenEntry[], query: string): Scored[] {
  if (!query) {
    // 空查询时按「打开的在前」列出来，不做任何过滤 —— 刚按下快捷键就能
    // 直接按上下键选最近那几篇
    return entries.map((entry) => ({
      entry,
      hits: [],
      score: entry.open ? OPEN_BONUS : 0,
    }))
  }

  const out: Scored[] = []
  for (const entry of entries) {
    const onLabel = fuzzyMatch(query, entry.label)
    const onDetail = fuzzyMatch(query, entry.detail)
    if (!onLabel && !onDetail) continue

    const base = entry.open ? OPEN_BONUS : 0
    if (onLabel) {
      out.push({
        entry,
        hits: onLabel,
        score: base + scoreOf(onLabel) + LABEL_BONUS + (entry.open ? 0 : NAME_BONUS),
      })
    } else {
      // 只命中路径时不给标题打高亮 —— 高亮画在没命中的字上比不高亮更让人困惑
      out.push({ entry, hits: [], score: base + scoreOf(onDetail as number[]) })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

/** 结果太多时列表本身会变成负担。上限之外的不画，但要说出来。 */
const MAX_SHOWN = 200

export class QuickOpenPanel {
  private readonly root: HTMLElement
  private readonly input: HTMLInputElement
  private readonly list: HTMLElement
  private readonly note: HTMLElement
  private entries: QuickOpenEntry[] = []
  private results: Scored[] = []
  private active = 0
  private truncated = false
  /** 这一次打开面板的序号 —— 遍历回来时用它判断面板是不是已经关了又开。 */
  private generation = 0

  constructor(private readonly options: QuickOpenOptions) {
    this.root = document.createElement('div')
    this.root.className = 'mosu-quickopen'
    this.root.hidden = true
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-modal', 'true')

    const box = document.createElement('div')
    box.className = 'mosu-quickopen__box'

    this.input = document.createElement('input')
    this.input.className = 'mosu-quickopen__input'
    this.input.type = 'text'
    // 跟命令面板一样的完整 combobox 模式：焦点始终在输入框，
    // 「当前高亮的是哪一项」靠 aria-activedescendant 告诉读屏软件
    this.input.setAttribute('role', 'combobox')
    this.input.setAttribute('aria-expanded', 'true')
    this.input.setAttribute('aria-autocomplete', 'list')
    this.input.setAttribute('aria-controls', 'mosu-quickopen-list')

    this.list = document.createElement('ul')
    this.list.className = 'mosu-quickopen__list'
    this.list.id = 'mosu-quickopen-list'
    this.list.setAttribute('role', 'listbox')
    this.list.tabIndex = -1

    this.note = document.createElement('div')
    this.note.className = 'mosu-quickopen__note'
    this.note.hidden = true

    box.append(this.input, this.list, this.note)
    this.root.append(box)
    document.body.append(this.root)

    this.retranslate()

    this.input.addEventListener('input', () => this.refresh())
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event))
    this.root.addEventListener('mousedown', (event) => {
      if (event.target === this.root) this.close()
    })
  }

  retranslate(): void {
    this.root.setAttribute('aria-label', t('panel.quickOpen.label'))
    this.list.setAttribute('aria-label', t('panel.quickOpen.results'))
    this.input.placeholder = t('panel.quickOpen.placeholder')
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else void this.open()
  }

  async open(): Promise<void> {
    const generation = ++this.generation
    this.root.hidden = false
    this.input.value = ''
    this.truncated = false

    // 先把「已打开的标签」画出来 —— 它不需要碰磁盘，可以立刻可用。
    // 工作区清单回来之后再合并
    this.entries = this.tabEntries()
    this.refresh()
    this.input.focus()

    const root = this.options.workspace()
    if (!root) return

    let files: WorkspaceFile[]
    try {
      const result = await this.options.walk(root)
      files = result.files
      this.truncated = result.truncated
    } catch {
      // 工作区读不出来时，「已打开的标签」那部分仍然可用
      return
    }
    // 面板已经关了、或者关掉又开了一次 —— 这批结果属于上一次
    if (generation !== this.generation || !this.isOpen) return

    this.entries = this.merge(files)
    this.refresh()

    // 标题最后补：它要读文件，比列目录慢一个量级，而没有标题时用文件名
    // 已经完全可用了
    const titles = await this.options
      .titles(files.map((file) => file.path))
      .catch(() => ({}) as Record<string, string | null>)
    if (generation !== this.generation || !this.isOpen) return

    for (const entry of this.entries) {
      const title = titles[entry.path]
      if (title) entry.label = title
    }
    this.refresh()
  }

  private tabEntries(): QuickOpenEntry[] {
    return this.options.openTabs().map((tab) => ({
      path: tab.path,
      label: tab.label,
      detail: tab.label,
      open: true,
    }))
  }

  /** 已打开的标签排前面，并且按路径去重。 */
  private merge(files: readonly WorkspaceFile[]): QuickOpenEntry[] {
    const tabs = this.tabEntries()
    const seen = new Set(tabs.map((entry) => entry.path))
    const out = [...tabs]
    for (const file of files) {
      if (seen.has(file.path)) continue
      seen.add(file.path)
      out.push({ path: file.path, label: file.name, detail: file.relative, open: false })
    }
    return out
  }

  close(): void {
    if (!this.isOpen) return
    this.root.hidden = true
    // 关掉之后焦点必须还回编辑器，否则下一次按键石沉大海
    this.options.restoreFocus()
  }

  private refresh(): void {
    const query = this.input.value.trim()
    this.results = searchEntries(this.entries, query)
    this.active = 0

    const shown = this.results.slice(0, MAX_SHOWN)
    this.list.replaceChildren(...shown.map((item, index) => this.renderItem(item, index)))

    if (this.results.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'mosu-quickopen__empty'
      empty.textContent = t('panel.quickOpen.empty')
      this.list.append(empty)
    }

    // 「没搜完」和「没搜到」是完全不同的两件事，必须说出来
    const hidden = this.results.length - shown.length
    const notes: string[] = []
    if (hidden > 0) notes.push(t('panel.quickOpen.more', { count: hidden }))
    if (this.truncated) notes.push(t('panel.quickOpen.truncated'))
    this.note.textContent = notes.join(' · ')
    this.note.hidden = notes.length === 0

    this.syncActive()
  }

  private renderItem(item: Scored, index: number): HTMLElement {
    const node = document.createElement('li')
    node.className = 'mosu-quickopen__item'
    node.setAttribute('role', 'option')
    node.id = `mosu-quickopen-item-${index}`
    node.dataset['path'] = item.entry.path

    const label = document.createElement('span')
    label.className = 'mosu-quickopen__label'
    label.append(...highlight(item.entry.label, item.hits))
    node.append(label)

    const detail = document.createElement('span')
    detail.className = 'mosu-quickopen__detail'
    detail.textContent = item.entry.open ? t('panel.quickOpen.openTab') : item.entry.detail
    node.append(detail)

    // 用 mousedown 而不是 click：click 之前输入框会先失焦
    node.addEventListener('mousedown', (event) => {
      event.preventDefault()
      this.run(index, event.metaKey || event.ctrlKey)
    })
    node.addEventListener('mousemove', () => {
      this.active = index
      this.syncActive()
    })
    return node
  }

  private syncActive(): void {
    const items = [...this.list.querySelectorAll<HTMLElement>('.mosu-quickopen__item')]
    items.forEach((item, index) => {
      const on = index === this.active
      item.classList.toggle('is-active', on)
      item.setAttribute('aria-selected', String(on))
      if (on) {
        item.scrollIntoView({ block: 'nearest' })
        this.input.setAttribute('aria-activedescendant', item.id)
      }
    })
    if (items.length === 0) this.input.removeAttribute('aria-activedescendant')
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      this.run(this.active, event.metaKey || event.ctrlKey)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const total = Math.min(this.results.length, MAX_SHOWN)
      if (total === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      this.active = (this.active + step + total) % total
      this.syncActive()
    }
  }

  private run(index: number, newTab: boolean): void {
    const picked = this.results[index]
    if (!picked) return
    // 先关再开：打开会抢焦点
    this.close()
    if (newTab) this.options.openInNewTab(picked.entry.path)
    else this.options.open(picked.entry.path)
  }
}

/** 把命中的字符包成 `<mark>`，其余按原文。跟命令面板同一套。 */
function highlight(text: string, hits: number[]): Node[] {
  if (hits.length === 0) return [document.createTextNode(text)]

  const nodes: Node[] = []
  const set = new Set(hits)
  let buffer = ''
  let marked = false

  const flush = (): void => {
    if (!buffer) return
    if (marked) {
      const mark = document.createElement('mark')
      mark.textContent = buffer
      nodes.push(mark)
    } else {
      nodes.push(document.createTextNode(buffer))
    }
    buffer = ''
  }

  for (let i = 0; i < text.length; i++) {
    const on = set.has(i)
    if (on !== marked) {
      flush()
      marked = on
    }
    buffer += text[i]
  }
  flush()
  return nodes
}
