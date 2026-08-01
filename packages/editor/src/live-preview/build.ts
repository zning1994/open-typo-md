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
import { BLOCK_NODES, INLINE_NODES, MARK_NODES, headingLevel } from '@typo/markdown'
import { livePreviewConfig } from '../config.js'
import { activeState, revealsLine, revealsRange, type ActiveState } from './active.js'
import { BulletWidget, ImageWidget, RuleWidget } from './widgets.js'

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
const MARK_CLASS = 'cm-typo-mark'

const BULLET_CHARS = new Set(['-', '*', '+'])

class Builder {
  readonly decorations: Range<Decoration>[] = []
  readonly atomic: Range<Decoration>[] = []
  private readonly lineSeen = new Set<string>()

  constructor(
    readonly state: EditorState,
    readonly active: ActiveState,
    readonly resolveAsset: (src: string) => string,
    readonly renderImages: boolean,
  ) {}

  mark(from: number, to: number, cls: string): void {
    if (to <= from) return
    this.decorations.push(markDeco(cls).range(from, to))
  }

  private lastHiddenTo = 0

  /**
   * 隐藏一段源码。同时登记到 atomic，让方向键一次跨过去。
   *
   * 这里强制「隐藏区间互不重叠」这条不变量：重叠的 replace 装饰会让
   * CodeMirror 在渲染时直接抛错，属于必炸型 bug，而触发它的往往是嵌套结构
   * （列表项里的分隔线、图片 alt 里的强调、`### 标题 ###` 里两个标记抢同一个空格）。
   *
   * 与其在每条规则里各自小心，不如在唯一的出口上兜住 —— 后来的区间被裁到
   * 前一个的结尾之后，裁没了就丢弃。CommonMark 全量语料的回归测试守着这条线。
   */
  hide(from: number, to: number, widget?: Decoration): void {
    const start = Math.max(from, this.lastHiddenTo)
    if (to <= start) return
    const deco = widget ?? HIDDEN
    this.decorations.push(deco.range(start, to))
    this.atomic.push(deco.range(start, to))
    this.lastHiddenTo = to
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
  const b = new Builder(state, activeState(state), cfg.assetResolver, cfg.renderImages)
  const tree = syntaxTree(state)

  for (const range of visible) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => handleNode(b, node, range),
    })
  }

  return {
    decorations: Decoration.set(b.decorations, true),
    atomic: Decoration.set(b.atomic, true),
  }
}

function handleNode(b: Builder, node: SyntaxNodeRef, clip: { from: number; to: number }): void {
  const name = node.name

  const level = headingLevel(name)
  if (level > 0) {
    b.lines(node.from, node.to, `cm-typo-heading cm-typo-h${level}`, clip)
    return
  }

  switch (name) {
    case BLOCK_NODES.blockquote:
      b.lines(node.from, node.to, 'cm-typo-quote', clip)
      return

    case BLOCK_NODES.fencedCode:
    case BLOCK_NODES.codeBlock:
      b.lines(node.from, node.to, 'cm-typo-code-block', clip)
      return

    case BLOCK_NODES.horizontalRule:
      handleRule(b, node)
      return

    case INLINE_NODES.emphasis:
      b.mark(node.from, node.to, 'cm-typo-em')
      return
    case INLINE_NODES.strongEmphasis:
      b.mark(node.from, node.to, 'cm-typo-strong')
      return
    case INLINE_NODES.strikethrough:
      b.mark(node.from, node.to, 'cm-typo-strike')
      return
    case INLINE_NODES.inlineCode:
      b.mark(node.from, node.to, 'cm-typo-code-inline')
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

function handleRule(b: Builder, node: SyntaxNodeRef): void {
  const line = b.state.doc.lineAt(node.from)
  b.line(line.from, 'cm-typo-hr-line')
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
    b.mark(node.from, node.to, 'cm-typo-list-number')
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
  b.mark(node.from, node.to, 'cm-typo-link')
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
    b.mark(node.from, node.to, 'cm-typo-image-source')
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
    b.mark(node.from, node.to, 'cm-typo-image-source')
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
