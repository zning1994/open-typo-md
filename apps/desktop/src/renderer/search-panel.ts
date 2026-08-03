/**
 * 全工作区搜索面板（issue #39）。
 *
 * ## 跟 ⌘F 的分工
 *
 * ⌘F 是**当前文档**里的查找替换（CodeMirror 自带的那一套，不动）；
 * ⌘⇧F 是**整个工作区**。两件事的结果形态完全不同 —— 前者是在正文里高亮，
 * 后者是一张跨文件的结果列表 —— 所以不共用面板。
 *
 * ## 结果是推回来的，不是等回来的
 *
 * 几百份文档搜完要几百毫秒到几秒。等它一次返回的话，用户按下回车之后面对的是
 * 一段没有任何反馈的空白。所以 main 分批推（见 main/workspace-scan.ts），
 * 这一层收一批画一批。
 *
 * **每一批都带搜索 id**：用户改查询词时上一次可能还在跑，而它的结果会晚一步
 * 到达。没有 id 的话，旧结果会涌进新列表里，而且看起来完全合理。
 *
 * ## 面板是常驻侧栏，不是浮层
 *
 * 命令面板和 Quick Open 是「选一个然后消失」的东西，浮层合适。搜索结果要**一边
 * 看一边点**：点开一个文件看看是不是要找的，不是就回来点下一个。做成浮层的话
 * 每点一次就消失一次，用户得重新搜一遍。
 */
import { t } from './i18n.js'
import type { FileMatches, SearchOptions, SearchProgressEvent } from '../shared/channels.js'

export interface SearchPanelOptions {
  workspace: () => string | null
  start: (root: string, query: string, options: SearchOptions) => Promise<number>
  cancel: () => Promise<void>
  onProgress: (handler: (event: SearchProgressEvent) => void) => () => void
  /** 打开某个文件并把光标放到 `offset`。 */
  reveal: (path: string, offset: number) => void
  restoreFocus: () => void
}

/** 结果行里前后各留多少字符 —— 再多屏幕上也放不下。 */
const CONTEXT = 40

export class SearchPanel {
  private readonly root: HTMLElement
  private readonly input: HTMLInputElement
  private readonly status: HTMLElement
  private readonly list: HTMLElement
  private readonly toggles: Record<'caseSensitive' | 'wholeWord' | 'regex', HTMLButtonElement>
  private options: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false }
  private currentId = 0
  private matches: FileMatches[] = []
  private searching = false
  private truncated = false
  private debounce: ReturnType<typeof setTimeout> | null = null
  /** 本次搜索的 id 还没回来 —— 期间到达的结果先攒在 `pending` 里。 */
  private awaitingId = false
  private pending: SearchProgressEvent[] = []

  constructor(
    host: HTMLElement,
    private readonly deps: SearchPanelOptions,
  ) {
    this.root = document.createElement('aside')
    this.root.className = 'mosu-search'
    this.root.hidden = true
    this.root.setAttribute('role', 'complementary')

    const header = document.createElement('div')
    header.className = 'mosu-search__header'

    this.input = document.createElement('input')
    this.input.type = 'search'
    this.input.className = 'mosu-search__input'
    header.append(this.input)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'mosu-search__close'
    close.textContent = '×'
    close.addEventListener('click', () => this.close())
    header.append(close)
    this.root.append(header)

    const bar = document.createElement('div')
    bar.className = 'mosu-search__options'
    this.toggles = {
      caseSensitive: this.makeToggle('caseSensitive', 'Aa'),
      wholeWord: this.makeToggle('wholeWord', '|ab|'),
      regex: this.makeToggle('regex', '.*'),
    }
    bar.append(this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regex)
    this.root.append(bar)

    this.status = document.createElement('div')
    this.status.className = 'mosu-search__status'
    // 结果是异步涌进来的，读屏软件要能知道「搜完了、有几条」
    this.status.setAttribute('role', 'status')
    this.status.setAttribute('aria-live', 'polite')
    this.root.append(this.status)

    this.list = document.createElement('div')
    this.list.className = 'mosu-search__list'
    this.root.append(this.list)

    // 边敲边搜，但要去抖：不去抖的话在大工作区里连敲五个字符会开五次遍历。
    // main 那边虽然会作废掉前四次，但那四次的磁盘 IO 已经发生了
    this.input.addEventListener('input', () => this.scheduleSearch())
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.close()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        this.runSearch()
      }
    })

    this.list.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const hit = target.closest<HTMLElement>('[data-offset]')
      if (!hit) return
      this.deps.reveal(hit.dataset['path'] as string, Number(hit.dataset['offset']))
    })

    this.deps.onProgress((progress) => this.onProgress(progress))
    this.retranslate()
    host.append(this.root)
  }

  private makeToggle(
    key: 'caseSensitive' | 'wholeWord' | 'regex',
    label: string,
  ): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mosu-search__toggle'
    button.textContent = label
    // 开关状态靠 aria-pressed 而不是只靠一个高亮类 —— 后者读屏软件读不出来
    button.setAttribute('aria-pressed', 'false')
    button.addEventListener('click', () => {
      this.options = { ...this.options, [key]: !this.options[key] }
      button.setAttribute('aria-pressed', String(this.options[key]))
      button.classList.toggle('is-on', this.options[key])
      this.runSearch()
    })
    return button
  }

  retranslate(): void {
    this.root.setAttribute('aria-label', t('panel.search.label'))
    this.input.placeholder = t('panel.search.placeholder')
    this.input.setAttribute('aria-label', t('panel.search.label'))
    this.list.setAttribute('aria-label', t('panel.search.results'))
    this.toggles.caseSensitive.title = t('panel.search.caseSensitive')
    this.toggles.caseSensitive.setAttribute('aria-label', t('panel.search.caseSensitive'))
    this.toggles.wholeWord.title = t('panel.search.wholeWord')
    this.toggles.wholeWord.setAttribute('aria-label', t('panel.search.wholeWord'))
    this.toggles.regex.title = t('panel.search.regex')
    this.toggles.regex.setAttribute('aria-label', t('panel.search.regex'))
    this.render()
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  open(): void {
    this.root.hidden = false
    this.input.focus()
    this.input.select()
    this.render()
  }

  close(): void {
    if (!this.isOpen) return
    this.root.hidden = true
    // 关掉面板就把跑着的那次作废 —— 结果没人看了，磁盘不该继续转
    void this.deps.cancel()
    this.searching = false
    this.awaitingId = false
    this.pending = []
    this.deps.restoreFocus()
  }

  /** 用一段选中的文字开搜（右键「在工作区中查找」之类的入口用）。 */
  openWith(query: string): void {
    this.open()
    this.input.value = query
    this.runSearch()
  }

  private scheduleSearch(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.runSearch(), 200)
  }

  private runSearch(): void {
    if (this.debounce) {
      clearTimeout(this.debounce)
      this.debounce = null
    }
    const root = this.deps.workspace()
    const query = this.input.value

    this.matches = []
    this.truncated = false

    if (!root || !query) {
      this.searching = false
      // 攒着的那些属于已经作废的上一次，跟着一起丢。留着的话它们会在
      // 上一次的 `start` 回来时被冲进一个本该是空的列表
      this.awaitingId = false
      this.pending = []
      // 没有工作区时把原因说出来。空着一个搜不出东西的框，用户会以为是坏了
      void this.deps.cancel()
      this.render()
      return
    }

    this.searching = true
    // 在拿到这次的 id 之前，到达的结果一律先攒着（见 `onProgress`）
    this.awaitingId = true
    this.pending = []
    this.render()

    void this.deps.start(root, query, this.options).then((id) => {
      this.currentId = id
      this.awaitingId = false
      const buffered = this.pending
      this.pending = []
      for (const progress of buffered) this.consume(progress)
    })
  }

  /**
   * 收一批结果。
   *
   * **id 还没回来时先攒着，不能直接按 id 判。** 这里有一个窄但真实的窗口：
   * 用户改查询词时，`runSearch` 已经把列表清空了，而 main 还没收到新的
   * `start`，于是上一次搜索仍在推结果 —— 那些结果带的正是**上一次**的 id，
   * 而此刻 `currentId` 也还是上一次的值，按 id 比是放行的。
   * 表现是新一次的列表里混着上一次的命中，看起来完全合理。
   *
   * 攒着而不是丢掉：丢掉的话，如果本次的头几批恰好赶在 id 之前到达，
   * 用户会**静默地少看到几个文件** —— 那比多看到几个更糟。
   */
  private onProgress(progress: SearchProgressEvent): void {
    if (this.awaitingId) {
      this.pending.push(progress)
      return
    }
    this.consume(progress)
  }

  private consume(progress: SearchProgressEvent): void {
    if (progress.id !== this.currentId) return

    this.matches.push(...progress.matches)
    if (progress.truncated) this.truncated = true
    if (progress.done) this.searching = false
    this.render()
  }

  private render(): void {
    const hits = this.matches.reduce((sum, file) => sum + file.hits.length, 0)

    const notes: string[] = []
    if (!this.deps.workspace()) notes.push(t('panel.search.noWorkspace'))
    else if (this.searching) notes.push(t('panel.search.searching'))
    else if (this.input.value && this.matches.length === 0) notes.push(t('panel.search.empty'))
    if (this.matches.length > 0) {
      notes.push(t('panel.search.summary', { files: this.matches.length, hits }))
    }
    if (this.truncated) notes.push(t('panel.search.truncated'))
    this.status.textContent = notes.join(' · ')

    this.list.replaceChildren(...this.matches.map((file) => this.renderFile(file)))
  }

  private renderFile(file: FileMatches): HTMLElement {
    const group = document.createElement('div')
    group.className = 'mosu-search__file'

    const head = document.createElement('div')
    head.className = 'mosu-search__filename'
    head.textContent = file.relative
    head.title = file.path
    group.append(head)

    for (const hit of file.hits) {
      const row = document.createElement('div')
      row.className = 'mosu-search__hit'
      row.dataset['path'] = file.path
      row.dataset['offset'] = String(hit.offset)

      const lineNo = document.createElement('span')
      lineNo.className = 'mosu-search__line'
      lineNo.textContent = String(hit.line)
      row.append(lineNo)

      const text = document.createElement('span')
      text.className = 'mosu-search__text'
      // 命中在长行深处时，从命中处往两边截 —— 从行首截的话屏幕上看到的是
      // 一段跟查询词毫无关系的文字
      const start = Math.max(0, hit.from - CONTEXT)
      const before = (start > 0 ? '…' : '') + hit.text.slice(start, hit.from)
      const matched = hit.text.slice(hit.from, hit.to)
      const after =
        hit.text.slice(hit.to, hit.to + CONTEXT) +
        (hit.text.length > hit.to + CONTEXT ? '…' : '')

      const mark = document.createElement('mark')
      mark.textContent = matched
      text.append(document.createTextNode(before), mark, document.createTextNode(after))
      row.append(text)

      group.append(row)
    }
    return group
  }
}
