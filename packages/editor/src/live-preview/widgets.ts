/**
 * 实时预览用到的 widget。
 *
 * 共同约束：
 * - widget 不持有任何编辑状态。所有改动都必须转成对主文档的 transaction
 *   （docs/design/02 §6 的铁律），否则撤销栈会和显示脱节。
 * - 渲染失败必须降级为「显示源码」，不能吞内容（原则 P2）。
 */
import { EditorView, WidgetType } from '@codemirror/view'
import { livePreviewConfig } from '../config.js'

/**
 * 取当前的可见文案。
 *
 * 每次 `toDOM` 都现取而不是构造时存下来：widget 会被 CodeMirror 缓存和复用
 * （`eq` 说相等就不重建），存下来的话换语言之后，视口里没被改动过的那些
 * 代码块角标会留在旧语言里。
 */
function labelsOf(view: EditorView) {
  return view.state.facet(livePreviewConfig).labels
}

/** 无序列表的项目符号。把 `-` / `*` / `+` 统一显示成 `•`，源码里仍是原字符。 */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-typo-bullet'
    span.textContent = '•'
    // 项目符号是纯装饰，读屏软件应该读列表语义而不是这个字符
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  override ignoreEvent(): boolean {
    return false
  }
}

/**
 * 行内 `<br>`：真的换一行。
 *
 * `lineBreaks` 必须如实报 1 —— CodeMirror 靠它算行高与坐标。不报的话，
 * 光标定位、滚动、`coordsAt` 全都会按「这一行没换过」来算，点击位置会偏。
 */
export class LineBreakWidget extends WidgetType {
  override eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-typo-html-br'
    span.appendChild(document.createElement('br'))
    return span
  }
  override get lineBreaks(): number {
    return 1
  }
  override ignoreEvent(): boolean {
    return false
  }
}

/** 分隔线。替换掉整行的 `---`。 */
export class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-typo-hr'
    span.setAttribute('role', 'separator')
    return span
  }
  override ignoreEvent(): boolean {
    return false
  }
}

/**
 * 让「整块替换」型的 widget 点一下就还原成源码。
 *
 * 为什么需要它：块级 widget 盖住了原来那几行，浏览器把点击落在 widget 内部，
 * CodeMirror 映射出来的位置未必落进被替换的区间里 —— 表现就是**点了没反应**，
 * 用户只能靠方向键摸进去。而「点一下改它」是看到一张图/一个公式之后
 * 最自然的动作。
 *
 * `posAtDOM` 给的是被替换区间的起点，落在显形判定的闭区间内，正好。
 */
export function revealOnClick(view: EditorView, host: HTMLElement): void {
  host.addEventListener('mousedown', (event) => {
    event.preventDefault()
    view.dispatch({ selection: { anchor: view.posAtDOM(host) } })
    view.focus()
  })
}

/**
 * 代码块右上角的语言选择器。
 *
 * 之前这里是纯 CSS 的 `::after { content: attr(data-typo-lang) }`，只能看不能点。
 * 换成真元素是为了让它可交互，但有两条约束要一起满足：
 *
 * 1. **不能占据行内空间** —— 它挂在代码首行上，一旦参与布局就会把代码顶右边去。
 *    所以用绝对定位脱离文档流（`.cm-typo-code-first` 已经是 `position: relative`）。
 * 2. **不能持有状态** —— 选择的结果必须立刻写回围栏的语言标注，
 *    走一次普通 transaction（docs/design/02 §6 的铁律）。
 *    这里连 `<select>` 的当前值都不自己记：它每次都从文档重新渲染。
 *
 * 用原生 `<select>` 而不是自绘下拉：一百多种语言，原生控件自带键盘导航、
 * 首字母跳转、以及各平台一致的滚动行为。自绘要把这些重做一遍才能追平。
 *
 * ## 已知粗糙之处：首行很长时会跟代码叠在一起
 *
 * 它是绝对定位的，不占行内空间 —— 于是首行代码长到右边时会从它下面穿过去。
 * 观感上像是渲染出错了（其实两者都画对了，只是重叠）。
 *
 * **没有顺手修**是因为直觉上那个解法会引入更糟的问题：给首行加 `padding-right`
 * 把文字挡在选择器左边，会让首行的横向滚动区比其他行**窄一截**，
 * 而代码块的横向滚动是逐行同步的（见 ../code-block.ts）—— 首行从此跟其余行
 * 对不齐，那比重叠难看得多。
 *
 * 真正的解法多半是让选择器随横向滚动一起移动，或者只在悬停时出现。
 * 两条都要单独想清楚，不适合捎带着做。
 */
export class CodeLanguageWidget extends WidgetType {
  constructor(
    /** 当前语言的规范名；空串表示没标注语言。 */
    readonly language: string,
    /** 可选项，已排序。 */
    readonly choices: readonly string[],
  ) {
    super()
  }

  override eq(other: CodeLanguageWidget): boolean {
    // choices 是同一个常量数组，比引用就够；language 才是会变的那个
    return other.language === this.language && other.choices === this.choices
  }

  toDOM(view: EditorView): HTMLElement {
    const select = document.createElement('select')
    select.className = 'cm-typo-code-lang'
    const labels = labelsOf(view)
    select.title = labels.codeLanguage
    select.setAttribute('aria-label', labels.codeLanguage)
    select.setAttribute('contenteditable', 'false')

    const blank = document.createElement('option')
    blank.value = ''
    blank.textContent = labels.plainText
    select.appendChild(blank)

    // 文档里写的语言若不在清单里（拼错、或是我们不认识的语言），
    // 也要作为一个选项存在，否则 select 会显示成别的值，等于悄悄改了用户的字
    if (this.language && !this.choices.includes(this.language)) {
      const custom = document.createElement('option')
      custom.value = this.language
      custom.textContent = this.language
      select.appendChild(custom)
    }

    for (const name of this.choices) {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      select.appendChild(option)
    }

    select.value = this.language
    select.addEventListener('change', () => {
      setFenceLanguage(view, view.posAtDOM(select), select.value)
    })
    // 下拉展开靠 mousedown，别让编辑器把它当成「把光标放这儿」
    select.addEventListener('mousedown', (event) => event.stopPropagation())

    return select
  }

  override ignoreEvent(): boolean {
    return true
  }
}

/** 围栏行：可选缩进 + 三个以上的 ` 或 ~ + 信息串。 */
const FENCE_LINE = /^(\s*[`~]{3,})(.*)$/

/**
 * 改写 pos 所在代码块的围栏语言标注。
 *
 * 从内容行往上找围栏行，而不是信任 widget 构造时的位置 —— widget 会因
 * `eq()` 相等而被复用，存下来的位置可能已经过期。
 */
function setFenceLanguage(view: EditorView, pos: number, language: string): void {
  const { doc } = view.state
  const line = doc.lineAt(pos)
  if (line.number <= 1) return

  const fence = doc.line(line.number - 1)
  const match = FENCE_LINE.exec(fence.text)
  if (!match) return

  const from = fence.from + (match[1] as string).length
  view.dispatch({
    changes: { from, to: fence.to, insert: language },
    userEvent: 'input.typo.code-language',
  })
}

/**
 * 任务列表的复选框，替换掉 `[ ]` / `[x]`。
 *
 * 这是第一个**可交互**的 widget，因此也是第一次真刀真枪地兑现
 * docs/design/02 §6 的铁律：widget 不持有任何状态，点击一律转成对主文档的
 * transaction。勾选之后撤销栈里躺着的是一次普通的文本替换，
 * ⌘Z 能撤回，脏标记会亮起，协同编辑将来也能原样走通。
 *
 * 位置从 `view.posAtDOM(dom)` 现取，而不是构造时存下来。存下来的话，
 * 一旦 widget 因 `eq()` 相等而被复用（相邻两个未勾选的任务就是这种情况），
 * 存的还是旧位置，点第二个会去改第一个。
 */
export class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-typo-task'
    box.checked = this.checked
    // contenteditable 里的表单控件必须显式声明不可编辑，否则光标能走进去
    box.setAttribute('contenteditable', 'false')
    const labels = labelsOf(view)
    box.setAttribute('aria-label', this.checked ? labels.taskDone : labels.taskTodo)

    box.addEventListener('mousedown', (event) => {
      // 阻止默认行为，免得点击顺带把光标挪进标记内部导致标记显形、
      // 复选框当场消失 —— 那样第二次点击就落空了
      event.preventDefault()
      toggleTaskAt(view, view.posAtDOM(box))
    })
    return box
  }

  override ignoreEvent(event: Event): boolean {
    // 只吞我们自己处理的那个事件，其余（选中、拖拽）照常交给编辑器
    return event.type === 'mousedown'
  }
}

/** 行首任务标记：`- [ ] 内容` 里的 `[ ]`。允许前面有列表标记与缩进。 */
const TASK_MARKER = /\[([ xX])\]/

/**
 * 切换 pos 所在行的任务标记。
 *
 * 在**行文本**里找标记而不是查语法树：任务标记必定是列表项内容的第一个东西，
 * 一行至多一个，正则足够可靠，而且不依赖 widget 拿到精确到字符的位置
 * （`posAtDOM` 落在替换区间的边界上，差一个字符都可能查错节点）。
 */
function toggleTaskAt(view: EditorView, pos: number): void {
  const line = view.state.doc.lineAt(pos)
  const match = TASK_MARKER.exec(line.text)
  if (!match) return

  const from = line.from + (match.index ?? 0) + 1
  const insert = match[1] === ' ' ? 'x' : ' '
  view.dispatch({
    changes: { from, to: from + 1, insert },
    userEvent: 'input.typo.task',
  })
}

/**
 * HTML 实体，例如 `&amp;` 显示成 `&`。
 *
 * 解码不出来的实体压根不会走到这里（build.ts 那边直接放弃装饰，原样显示），
 * 所以这个 widget 只负责画一个已经确定的字符。
 */
export class EntityWidget extends WidgetType {
  constructor(
    readonly text: string,
    /** 原始写法，放进 title 里，方便用户确认自己写了什么。 */
    readonly source: string,
  ) {
    super()
  }

  override eq(other: EntityWidget): boolean {
    return other.text === this.text && other.source === this.source
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-typo-entity'
    span.textContent = this.text
    span.title = this.source
    return span
  }

  override ignoreEvent(): boolean {
    return false
  }
}

/**
 * 图片。
 *
 * `src` 已经过 AssetResolver 处理（见 ../config.ts）——
 * widget 自己绝不拼 `file://`，路径合法性由宿主把关（docs/design/01 §6）。
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    /** 原始 Markdown 源码，加载失败时显示它，保证内容不被吞掉。 */
    readonly source: string,
  ) {
    super()
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.source === this.source
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-typo-image'

    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    img.addEventListener('error', () => {
      wrap.classList.add('cm-typo-image--broken')
      wrap.textContent = this.source
      wrap.title = labelsOf(view).imageFailed(this.src)
    })
    wrap.appendChild(img)
    return wrap
  }

  override ignoreEvent(): boolean {
    // 让点击事件冒泡给编辑器，这样点图片能把光标放到对应源码位置
    return false
  }
}
