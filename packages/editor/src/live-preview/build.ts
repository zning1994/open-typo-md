/**
 * 装饰构建：从 (语法树, 选区, 视口) 算出该画什么。
 *
 * 刻意写成**不依赖 EditorView 的纯函数**，理由有二：
 * 1. 可以脱离 DOM 单测 —— 直接喂一个 EditorState 进来断言输出，
 *    不必启动浏览器（docs/design/07 §1 的分层要求）。
 * 2. 强制把「算什么」和「什么时候算」分开，后者是 ./index.ts 的事。
 *
 * 规则总表见 docs/design/02-editor-core.md §5、§6。
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import {
  BLOCK_NODES,
  FOOTNOTE_NODES,
  FRONTMATTER_NODES,
  MATH_NODES,
  INLINE_NODES,
  MARK_NODES,
  TABLE_NODES,
  TASK_NODES,
  decodeEntity,
  headingLevel,
} from '@mosu/markdown'
import { livePreviewConfig } from '../config.js'
import { activeState, revealsLine, revealsRange, type ActiveState } from './active.js'
import { htmlLayoutOf } from './inline-html.js'
import { alignmentsOf, delimiterRowLayout, rowLayout, tableIsActive } from './tables.js'
import { MathWidget } from '../math.js'
import {
  BulletWidget,
  EntityWidget,
  ImageWidget,
  LineBreakWidget,
  RuleWidget,
  TaskCheckboxWidget,
} from './widgets.js'

export interface BuildResult {
  /** 全部装饰。 */
  decorations: DecorationSet
  /**
   * 仅「被隐藏/替换掉的源码区间」。
   *
   * 单独一份的原因：atomicRanges 会让光标一次跳过整个区间。若把样式类的
   * mark 装饰也算进去，光标就会跳过整段加粗文字，完全没法编辑
   * （docs/design/02 §4.1）。
   */
  atomic: DecorationSet
}

const HIDDEN = Decoration.replace({})

const markCache = new Map<string, Decoration>()
function markDeco(cls: string): Decoration {
  let deco = markCache.get(cls)
  if (!deco) {
    deco = Decoration.mark({ class: cls })
    markCache.set(cls, deco)
  }
  return deco
}

const lineCache = new Map<string, Decoration>()
function lineDeco(cls: string): Decoration {
  let deco = lineCache.get(cls)
  if (!deco) {
    deco = Decoration.line({ class: cls })
    lineCache.set(cls, deco)
  }
  return deco
}

/** 显形时给标记本身加的类 —— 让它以弱化的颜色出现，不喧宾夺主。 */
const MARK_CLASS = 'cm-mosu-mark'

const BULLET_CHARS = new Set(['-', '*', '+'])

class Builder {
  readonly decorations: Range<Decoration>[] = []
  readonly atomic: Range<Decoration>[] = []
  private readonly lineSeen = new Set<string>()

  /** 已经处理过行内 HTML 的容器，避免同一个段落被它的每个标签各扫一遍。 */
  readonly htmlSeen = new Set<string>()

  constructor(
    readonly state: EditorState,
    readonly active: ActiveState,
    readonly resolveAsset: (src: string) => string,
    readonly renderImages: boolean,
    readonly renderInlineHtml: boolean,
  ) {}

  mark(from: number, to: number, cls: string): void {
    if (to <= from) return
    this.decorations.push(markDeco(cls).range(from, to))
  }

  private readonly hidden: { from: number; to: number; deco: Decoration }[] = []

  /**
   * 隐藏一段源码。同时登记到 atomic，让方向键一次跨过去。
   *
   * 区间**先攒着**，等全部规则跑完再统一消解重叠（见 `resolveHidden`）。
   *
   * 早先是边收边裁的：拿一个 `lastHiddenTo` 游标，后来的区间裁到它之后。
   * 那份实现悄悄依赖了「装饰按文档顺序发出」这个前提 —— 树遍历确实是文档序，
   * 但**规则本身不一定**：表格行的处理是拿到行节点就把整行的竖线一次性发完，
   * 直接跨到了行尾，于是行内那些还没轮到的强调标记全部 `to <= lastHiddenTo`，
   * 被当成重叠**静默丢弃**，表现是「表格单元格里的加粗不生效」。
   *
   * 攒起来再排序消解，这个前提就不存在了，规则可以按自己最自然的方式发装饰。
   */
  hide(from: number, to: number, widget?: Decoration): void {
    if (to <= from) return
    this.hidden.push({ from, to, deco: widget ?? HIDDEN })
  }

  /**
   * 消解重叠，把结果并进 decorations / atomic。
   *
   * 「隐藏区间互不重叠」是条硬性不变量：重叠的 replace 装饰会让 CodeMirror
   * 在渲染时直接抛错，属于必炸型 bug，而触发它的往往是嵌套结构（列表项里的
   * 分隔线、图片 alt 里的强调、`### 标题 ###` 里两个标记抢同一个空格）。
   * 与其在每条规则里各自小心，不如在唯一的出口上兜住。
   *
   * 排序规则是「起点升序，起点相同则长的在前」—— 等价于外层节点优先，
   * 跟树遍历的自然顺序一致，于是被裁掉的总是内层那个。
   * CommonMark 全量语料的回归测试守着这条线。
   */
  resolveHidden(): void {
    this.hidden.sort((a, b) => a.from - b.from || b.to - a.to)
    let lastTo = 0
    for (const { from, to, deco } of this.hidden) {
      const start = Math.max(from, lastTo)
      if (to <= start) continue
      this.decorations.push(deco.range(start, to))
      this.atomic.push(deco.range(start, to))
      lastTo = to
    }
  }

  line(pos: number, cls: string): void {
    const lineStart = this.state.doc.lineAt(pos).from
    const key = `${lineStart}:${cls}`
    if (this.lineSeen.has(key)) return
    this.lineSeen.add(key)
    this.decorations.push(lineDeco(cls).range(lineStart))
  }

  /** 给 [from, to] 覆盖到的每一行加行装饰，范围按可见区裁剪。 */
  lines(from: number, to: number, cls: string, clip: { from: number; to: number }): void {
    const doc = this.state.doc
    const start = doc.lineAt(Math.max(from, clip.from)).number
    const end = doc.lineAt(Math.min(to, clip.to)).number
    for (let n = start; n <= end; n++) this.line(doc.line(n).from, cls)
  }

  slice(from: number, to: number): string {
    return this.state.doc.sliceString(from, to)
  }
}

export function computeDecorations(
  state: EditorState,
  visible: readonly { from: number; to: number }[],
): BuildResult {
  const cfg = state.facet(livePreviewConfig)
  const b = new Builder(
    state,
    activeState(state),
    cfg.assetResolver,
    cfg.renderImages,
    cfg.renderInlineHtml,
  )
  const tree = syntaxTree(state)

  for (const range of visible) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => handleNode(b, node, range),
    })
  }

  b.resolveHidden()

  return {
    decorations: Decoration.set(b.decorations, true),
    atomic: Decoration.set(b.atomic, true),
  }
}

function handleNode(b: Builder, node: SyntaxNodeRef, clip: { from: number; to: number }): void {
  const name = node.name

  const level = headingLevel(name)
  if (level > 0) {
    b.lines(node.from, node.to, `cm-mosu-heading cm-mosu-h${level}`, clip)
    return
  }

  switch (name) {
    case BLOCK_NODES.blockquote:
      b.lines(node.from, node.to, 'cm-mosu-quote', clip)
      return

    case BLOCK_NODES.fencedCode:
    case BLOCK_NODES.codeBlock:
      b.lines(node.from, node.to, 'cm-mosu-code-block', clip)
      return

    case BLOCK_NODES.horizontalRule:
      handleRule(b, node)
      return

    case MATH_NODES.inline:
      handleInlineMath(b, node, 1)
      return
    case MATH_NODES.display:
      handleInlineMath(b, node, 2)
      return

    case FRONTMATTER_NODES.block:
      // 整块弱化成「元数据」的样子。里面的 YAML 高亮由混合解析器产出的
      // token 接管，不需要我们再加装饰
      b.lines(node.from, node.to, 'cm-mosu-frontmatter', clip)
      return
    case FRONTMATTER_NODES.mark:
      b.mark(node.from, node.to, MARK_CLASS)
      return

    case TABLE_NODES.header:
    case TABLE_NODES.row:
      handleTableRow(b, node)
      return

    // `TableDelimiter` 一名两用：挂在 Table 上的是**整条分隔行**，
    // 挂在行上的是单根竖线
    case TABLE_NODES.delimiter: {
      const parent = node.node.parent
      if (!parent) return
      if (parent.name === TABLE_NODES.table) handleDelimiterRow(b, node)
      else handlePipe(b, node, parent)
      return
    }

    case TASK_NODES.marker:
      handleTaskMarker(b, node)
      return

    case INLINE_NODES.escape:
      handleEscape(b, node)
      return
    case INLINE_NODES.entity:
      handleEntity(b, node)
      return

    case INLINE_NODES.url:
      handleBareUrl(b, node)
      return

    case INLINE_NODES.htmlTag:
      handleHtmlTag(b, node)
      return

    case FOOTNOTE_NODES.ref:
      handleFootnoteRef(b, node)
      return
    case FOOTNOTE_NODES.definition:
      b.lines(node.from, node.to, 'cm-mosu-footnote-def', clip)
      return

    case INLINE_NODES.emphasis:
      b.mark(node.from, node.to, 'cm-mosu-em')
      return
    case INLINE_NODES.strongEmphasis:
      b.mark(node.from, node.to, 'cm-mosu-strong')
      return
    case INLINE_NODES.strikethrough:
      b.mark(node.from, node.to, 'cm-mosu-strike')
      return
    case INLINE_NODES.inlineCode:
      b.mark(node.from, node.to, 'cm-mosu-code-inline')
      return

    case INLINE_NODES.link:
    case INLINE_NODES.autolink:
      handleLink(b, node)
      return
    case INLINE_NODES.image:
      handleImage(b, node)
      return

    case MARK_NODES.header:
      handleHeaderMark(b, node)
      return
    case MARK_NODES.quote:
      handleQuoteMark(b, node)
      return
    case MARK_NODES.list:
      handleListMark(b, node)
      return
    case MARK_NODES.emphasis:
    case MARK_NODES.strikethrough:
    case MARK_NODES.code:
      handleInlineMark(b, node)
      return
    case MARK_NODES.link:
      handleLinkMark(b, node)
      return

    default:
      // 不认识的节点一律不动 —— 原则 P2：绝不吞内容
      return
  }
}

/**
 * 表格行。
 *
 * 呈现方案见 ./tables.ts 开头：靠 CSS 匿名表格盒，没有 widget、没有第二状态。
 * 这里只负责挂类名和处理竖线。
 *
 * 竖线的显形规则是**整张表一起**，不是按行 —— 局部显形会让那一行脱出匿名
 * 表格盒，一张表当场劈成两张、列宽分家，比整体切换刺眼得多。
 * 而因为每个单元格的范围**包含了它左边那根竖线**（见 tables.ts），
 * 显形只是让竖线在格子内部露出来，列结构自始至终没动过。
 */
function handleTableRow(b: Builder, node: SyntaxNodeRef): void {
  const table = node.node.parent
  if (!table) return

  const isHeader = node.name === TABLE_NODES.header
  b.line(node.from, isHeader ? 'cm-mosu-tr cm-mosu-tr-head' : 'cm-mosu-tr')

  const { spans } = rowLayout(b.state, node.node)
  const aligns = alignmentsOf(b.state, table)

  for (const span of spans) {
    const align = aligns[span.column] ?? 'none'
    b.mark(
      span.from,
      span.to,
      align === 'none' ? 'cm-mosu-td' : `cm-mosu-td cm-mosu-td-${align}`,
    )
  }
}

/**
 * 单根竖线。
 *
 * 刻意由竖线节点自己处理，而不是在 handleTableRow 里一次性发完 —— 后者会让
 * 隐藏区间的发出顺序跳到行尾，历史上正是这样把单元格里的强调标记挤掉的
 * （现在 Builder 已经不依赖发出顺序了，但「谁的节点谁处理」仍然更好读）。
 */
function handlePipe(b: Builder, node: SyntaxNodeRef, row: SyntaxNode): void {
  const table = row.parent
  if (table && tableIsActive(b.state, table)) {
    b.mark(node.from, node.to, MARK_CLASS)
    return
  }
  b.hide(node.from, node.to)
}

/**
 * 分隔行（`| --- | :---: |`）在显形时也得摆成表格行。
 *
 * 不这么做的话，它会以一个普通块级行的身份卡在表头和数据行中间，
 * 把匿名表格盒**截成两张表** —— 表头和正文的列宽当场分家。
 * 隐藏它是块级装饰的事（见 blocks.ts），这里只管它露出来的时候。
 */
function handleDelimiterRow(b: Builder, node: SyntaxNodeRef): void {
  b.line(node.from, 'cm-mosu-tr cm-mosu-tr-delim')
  const { spans, pipes } = delimiterRowLayout(b.state, node.node)
  for (const span of spans) b.mark(span.from, span.to, 'cm-mosu-td')
  for (const at of pipes) b.mark(at, at + 1, MARK_CLASS)
}

/** 任务列表的 `[ ]` / `[x]`：换成真的复选框；光标在本行时露出源码。 */
function handleTaskMarker(b: Builder, node: SyntaxNodeRef): void {
  const line = b.state.doc.lineAt(node.from)
  if (revealsLine(b.active, line.number)) {
    b.mark(node.from, node.to, MARK_CLASS)
    return
  }
  const checked = b.slice(node.from, node.to).toLowerCase() === '[x]'
  b.hide(node.from, node.to, Decoration.replace({ widget: new TaskCheckboxWidget(checked) }))
}

/**
 * 转义字符：`\*` 藏掉反斜杠，只留 `*`。
 *
 * 显形规则用**闭区间**而不是整行 —— 转义是行内元素，按行显形会让整段文字
 * 在光标进出时左右横跳。
 */
function handleEscape(b: Builder, node: SyntaxNodeRef): void {
  if (revealsRange(b.active, node.from, node.to)) {
    b.mark(node.from, node.from + 1, MARK_CLASS)
    return
  }
  b.hide(node.from, node.from + 1)
}

/** HTML 实体：`&amp;` 显示成 `&`。认不出来的实体原样保留（原则 P2）。 */
function handleEntity(b: Builder, node: SyntaxNodeRef): void {
  const source = b.slice(node.from, node.to)
  const decoded = decodeEntity(source)
  if (decoded === null) return

  if (revealsRange(b.active, node.from, node.to)) {
    b.mark(node.from, node.to, MARK_CLASS)
    return
  }
  b.hide(node.from, node.to, Decoration.replace({ widget: new EntityWidget(decoded, source) }))
}

/**
 * GFM 自动链接：`www.example.com`、`https://x.io`、`a@b.com`。
 *
 * 解析器给的是一个**光秃秃的 `URL` 节点**，不像 CommonMark 的 `<...>`
 * 那样包在 `Autolink` 里。所以这里要先确认它不是行内链接 / 图片的目标部分，
 * 否则会把 `[文字](url)` 里已经被折叠的 URL 又画一遍。
 */
function handleBareUrl(b: Builder, node: SyntaxNodeRef): void {
  // 用「排除法」而不是「白名单法」：自动链接可以出现在标题、强调、
  // 表格单元格、列表项…… 任何行内上下文里，一条条列会漏。
  // 真正需要跳过的只有「URL 是别人的目标部分」这几种。
  const parent = node.node.parent
  if (parent && URL_CONTAINERS.has(parent.name)) return
  b.mark(node.from, node.to, 'cm-mosu-link cm-mosu-autolink')
}

/**
 * 行内 HTML。安全模型见 ./inline-html.ts 开头 —— 一句话：这里**不解析 HTML**，
 * 只按封闭标签集合挂类名，没有任何一个字节的用户内容进过 `innerHTML`。
 *
 * 一整个容器一次算完（而不是一个标签一个标签地算），因为配对本来就得看到两端。
 * 代价是可能给视口外的标签也发装饰 —— 上界是这个容器里的标签数，可以接受，
 * 换来的是「`<b>` 在视口上边、`</b>` 在下边」这种情况不会被误判成没闭合。
 */
function handleHtmlTag(b: Builder, node: SyntaxNodeRef): void {
  if (!b.renderInlineHtml) return

  const container = node.node.parent
  if (!container) return
  // 段落与它里面的链接可能起点相同，光用 from 会互相盖掉
  const key = `${container.name}:${container.from}:${container.to}`
  if (b.htmlSeen.has(key)) return
  b.htmlSeen.add(key)

  const { pairs, voids } = htmlLayoutOf(b.state, container)

  for (const { open, close } of pairs) {
    // 样式一直挂着（跟强调一致）：显形时露出来的是标签本身，不是排版效果
    b.mark(open.from, close.to, `cm-mosu-html cm-mosu-html-${open.cls}`)
    if (revealsRange(b.active, open.from, close.to)) {
      b.mark(open.from, open.to, MARK_CLASS)
      b.mark(close.from, close.to, MARK_CLASS)
    } else {
      b.hide(open.from, open.to)
      b.hide(close.from, close.to)
    }
  }

  for (const tag of voids) {
    if (revealsRange(b.active, tag.from, tag.to)) {
      b.mark(tag.from, tag.to, MARK_CLASS)
      continue
    }
    b.hide(tag.from, tag.to, Decoration.replace({ widget: new LineBreakWidget() }))
  }
}

/** 这些节点里的 `URL` 是链接目标，已由各自的 handler 折叠，不该再画一遍。 */
const URL_CONTAINERS = new Set<string>([
  INLINE_NODES.link,
  INLINE_NODES.image,
  INLINE_NODES.autolink,
  BLOCK_NODES.linkReference,
])

/**
 * 行内公式 `$…$`：整段换成渲染结果；光标进去就还原成源码。
 *
 * 显形用闭区间（跟其他行内元素一致）—— 光标贴在公式右侧时也要能接着改，
 * 否则用户没法在公式后面继续输入。
 */
function handleInlineMath(b: Builder, node: SyntaxNodeRef, markLength: number): void {
  if (revealsRange(b.active, node.from, node.to)) {
    b.mark(node.from, node.to, 'cm-mosu-math-source')
    return
  }
  const tex = b.slice(node.from + markLength, node.to - markLength)
  if (!tex.trim()) return // 空公式不渲染，原样留着让用户改
  // `$$…$$` 即便写在一行里也是**行间公式**，按 display 模式渲染
  const display = markLength === 2
  b.hide(node.from, node.to, Decoration.replace({ widget: new MathWidget(tex, display) }))
}

/** 脚注引用 `[^1]`：藏掉 `[^` 和 `]`，标签留着做上标。 */
function handleFootnoteRef(b: Builder, node: SyntaxNodeRef): void {
  b.mark(node.from, node.to, 'cm-mosu-footnote-ref')
  if (revealsRange(b.active, node.from, node.to)) return
  // `[^` 两个字符 + 收尾的 `]`
  b.hide(node.from, node.from + 2)
  b.hide(node.to - 1, node.to)
}

function handleRule(b: Builder, node: SyntaxNodeRef): void {
  const line = b.state.doc.lineAt(node.from)
  b.line(line.from, 'cm-mosu-hr-line')
  if (revealsLine(b.active, line.number)) {
    b.mark(line.from, line.to, MARK_CLASS)
    return
  }
  // 用节点自身的范围而不是整行：分隔线可以出现在列表项里（`- * * *`），
  // 从行首开始替换会把列表标记一起吃掉。
  // 同时不碰行尾换行 —— 覆盖换行的替换装饰不允许由 ViewPlugin 提供。
  b.hide(node.from, node.to, Decoration.replace({ widget: new RuleWidget() }))
}

function handleHeaderMark(b: Builder, node: SyntaxNodeRef): void {
  const line = b.state.doc.lineAt(node.from)

  // Setext 标题的下划线（===/---）自成一行。整行隐藏会留下一个空行，
  // 观感比不隐藏更糟，所以只弱化显示。
  const coversWholeLine = node.from <= line.from && node.to >= line.to
  if (coversWholeLine || revealsLine(b.active, line.number)) {
    b.mark(node.from, node.to, MARK_CLASS)
    return
  }

  if (node.to >= line.to) {
    // 收尾的 `#`（`# 标题 #` 这种写法），连同它前面的空格一起隐藏
    let from = node.from
    while (from > line.from && b.slice(from - 1, from) === ' ') from--
    b.hide(from, node.to)
  } else {
    // 行首的 `#`，连同后面的空格一起隐藏
    let to = node.to
    while (to < line.to && b.slice(to, to + 1) === ' ') to++
    b.hide(node.from, to)
  }
}

function handleQuoteMark(b: Builder, node: SyntaxNodeRef): void {
  const line = b.state.doc.lineAt(node.from)
  if (revealsLine(b.active, line.number)) {
    b.mark(node.from, node.to, MARK_CLASS)
    return
  }
  let to = node.to
  if (to < line.to && b.slice(to, to + 1) === ' ') to++
  b.hide(node.from, to)
}

function handleListMark(b: Builder, node: SyntaxNodeRef): void {
  const line = b.state.doc.lineAt(node.from)
  const text = b.slice(node.from, node.to)

  if (revealsLine(b.active, line.number)) {
    b.mark(node.from, node.to, MARK_CLASS)
    return
  }
  if (BULLET_CHARS.has(text)) {
    // 无序列表：把 -/*/+ 显示成 •。源码里仍是用户原来那个字符（G2）
    b.hide(node.from, node.to, Decoration.replace({ widget: new BulletWidget() }))
  } else {
    // 有序列表：编号本身就是内容的一部分，保留可见，只弱化
    b.mark(node.from, node.to, 'cm-mosu-list-number')
  }
}

function handleInlineMark(b: Builder, node: SyntaxNodeRef): void {
  const parent = node.node.parent
  if (!parent) return

  // 围栏代码块的 ``` 不隐藏：它是块的边界，藏了以后用户没法删掉代码块
  if (parent.name === BLOCK_NODES.fencedCode) {
    b.mark(node.from, node.to, MARK_CLASS)
    return
  }

  if (revealsRange(b.active, parent.from, parent.to)) {
    b.mark(node.from, node.to, MARK_CLASS)
  } else {
    b.hide(node.from, node.to)
  }
}

function linkMarksOf(node: SyntaxNode): SyntaxNode[] {
  const marks: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === MARK_NODES.link) marks.push(child)
  }
  return marks
}

function handleLinkMark(b: Builder, node: SyntaxNodeRef): void {
  const parent = node.node.parent
  // Link / Image / Autolink 内部的 LinkMark 由各自的 handler 统一处理，
  // 这里只兜底其他上下文（例如链接引用定义），避免重复装饰打架
  if (
    parent &&
    (parent.name === INLINE_NODES.link ||
      parent.name === INLINE_NODES.image ||
      parent.name === INLINE_NODES.autolink)
  ) {
    return
  }
  b.mark(node.from, node.to, MARK_CLASS)
}

function handleLink(b: Builder, node: SyntaxNodeRef): void {
  b.mark(node.from, node.to, 'cm-mosu-link')
  if (revealsRange(b.active, node.from, node.to)) return

  // 只折叠「确实有跳转目标」的链接：行内链接有 URL 子节点，引用式链接有 LinkLabel。
  //
  // 裸的 `[文字]` 不折叠 —— 解析器出于容错会把它也标成 Link，但它多半只是
  // 普通的方括号（`[[Wiki 链接]]`、`[TODO] 待办`）。折叠了就等于让方括号
  // 凭空消失，违反原则 P2。
  let hasTarget = false
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === INLINE_NODES.url || child.name === INLINE_NODES.linkLabel) {
      hasTarget = true
      break
    }
  }
  if (!hasTarget) return

  const marks = linkMarksOf(node.node)
  const open = marks[0]
  const close = marks[1]
  if (!open || !close) return // 结构不完整就原样显示，不猜

  b.hide(node.from, open.to) // `[` 或 `<`
  b.hide(close.from, node.to) // `](url)` / `][ref]` / `>`
}

function handleImage(b: Builder, node: SyntaxNodeRef): void {
  if (!b.renderImages || revealsRange(b.active, node.from, node.to)) {
    b.mark(node.from, node.to, 'cm-mosu-image-source')
    return
  }

  const marks = linkMarksOf(node.node)
  const open = marks[0]
  const close = marks[1]
  let url: string | null = null
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === INLINE_NODES.url) {
      url = b.slice(child.from, child.to)
      break
    }
  }

  // 拿不到 URL（引用式图片、语法不完整）就退回显示源码 —— 原则 P2
  if (!open || !close || url === null) {
    b.mark(node.from, node.to, 'cm-mosu-image-source')
    return
  }

  const alt = b.slice(open.to, close.from)
  const source = b.slice(node.from, node.to)
  b.hide(
    node.from,
    node.to,
    Decoration.replace({
      widget: new ImageWidget(b.resolveAsset(url), alt, source),
    }),
  )
}
