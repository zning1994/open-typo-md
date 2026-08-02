/**
 * 表格的结构计算。
 *
 * 单独成文件是因为**两侧都要用**：行内装饰（build.ts，走 ViewPlugin）需要
 * 单元格切分与对齐，块级装饰（blocks.ts，走 StateField）需要找到分隔行。
 * 逻辑写两遍必然走样。
 *
 * ## 呈现方案：CSS 匿名表格盒
 *
 * 没有 widget，没有第二状态 —— 表格**仍然是文本**，只是靠 CSS 摆成表格的样子：
 *
 * - 每个表格行的 `.cm-line` 挂 `display: table-row`；
 * - 行内每个单元格挂 `display: table-cell`。
 *
 * `.cm-content` 不是 `display: table`，但 CSS 2.1 规定：非表格父元素下**连续的**
 * `table-row` 子元素会被自动包进一个匿名表格盒。这正好是我们要的语义 ——
 * 连续的表格行自成一张表，中间夹一行普通段落就自然断成两张。
 * 跟代码块横向滚动同步靠 DOM 相邻关系是同一个路子，不额外打标记。
 *
 * 这样做的收益是列宽由浏览器按内容算，跟真表格一致；
 * 代价是**必须避免行结构被破坏**，所以分隔行的隐藏要走块级装饰（见 blocks.ts）。
 *
 * ## 单元格怎么切
 *
 * 关键决定：**每个单元格的范围包含它左边那根竖线**。
 *
 * 为什么不切在竖线外侧：光标进入表格时竖线要显形，而显形的竖线如果落在两个
 * `table-cell` 之间，浏览器会为它生成一个匿名单元格 —— 列数凭空多出来，
 * 整张表的列宽当场重排。把竖线包进单元格内部，显形与否都不影响列结构。
 */
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { TABLE_NODES } from '@mosu/markdown'

export type ColumnAlign = 'left' | 'center' | 'right' | 'none'

export interface TableCellSpan {
  from: number
  to: number
  /** 列序号，用于取对齐方式。 */
  column: number
}

const PIPE = '|'

export interface TableRowLayout {
  /** 单元格切分结果，至少一个。 */
  spans: TableCellSpan[]
  /** 竖线的文档位置，用于隐藏或弱化显示。 */
  pipes: number[]
}

/**
 * 行节点（TableHeader / TableRow）里的竖线位置。
 *
 * 走语法树而不是在文本里找 `|`：转义的 `\|` 是单元格内容，不是分界，
 * 解析器已经替我们分清了。
 */
function delimitersOf(row: SyntaxNode): number[] {
  const found: number[] = []
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === TABLE_NODES.delimiter) found.push(child.from)
  }
  return found
}

/**
 * 把一行按竖线位置切成单元格。
 *
 * 首尾的竖线是可选的（`a | b` 也是合法的 GFM 表格），所以不能假定竖线数量
 * 与列数的关系，只能按「内部竖线才是分界」来切。
 */
function layout(state: EditorState, lineFrom: number, pipes: number[]): TableRowLayout {
  const line = state.doc.lineAt(lineFrom)

  // 首尾竖线不参与切分：前导竖线属于第一格的前缀，收尾竖线属于最后一格的后缀
  let start = 0
  let end = pipes.length
  const firstNonSpace = line.from + (line.text.length - line.text.trimStart().length)
  if (pipes.length > 0 && (pipes[0] as number) <= firstNonSpace) start = 1
  const last = pipes[end - 1]
  if (last !== undefined && state.doc.sliceString(last + 1, line.to).trim() === '') end -= 1

  const boundaries = [line.from]
  for (let i = Math.max(start, 0); i < end; i++) {
    const at = pipes[i] as number
    if (at > line.from) boundaries.push(at)
  }
  boundaries.push(line.to)

  const spans: TableCellSpan[] = []
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const from = boundaries[i] as number
    const to = boundaries[i + 1] as number
    if (to > from) spans.push({ from, to, column: i })
  }
  return { spans, pipes }
}

export function rowLayout(state: EditorState, row: SyntaxNode): TableRowLayout {
  return layout(state, row.from, delimitersOf(row))
}

/**
 * 分隔行的切分。
 *
 * 它在语法树里是一个**没有子节点**的 `TableDelimiter`，拿不到竖线位置，
 * 只能扫文本。这里扫文本是安全的：分隔行的语法只允许 `-`、`:`、空格和 `|`，
 * 不存在需要转义的竖线。
 */
export function delimiterRowLayout(state: EditorState, row: SyntaxNode): TableRowLayout {
  const line = state.doc.lineAt(row.from)
  const pipes: number[] = []
  for (let i = 0; i < line.text.length; i++) {
    if (line.text[i] === PIPE) pipes.push(line.from + i)
  }
  return layout(state, line.from, pipes)
}

/**
 * 分隔行 —— `| --- | :---: |` 那一行。
 *
 * `TableDelimiter` 这个节点名**一名两用**：单根竖线也叫这个。
 * 区分靠层级 —— 挂在 `Table` 上的直接子节点才是整条分隔行，
 * 单根竖线挂在 `TableHeader` / `TableRow` 上。
 */
export function delimiterRowOf(table: SyntaxNode): SyntaxNode | null {
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === TABLE_NODES.delimiter) return child
  }
  return null
}

/**
 * 从分隔行解析各列对齐。
 *
 * 解析不出来（分隔行残缺、用户正在敲）就整列返回 `none`，退化成默认左对齐，
 * 不猜、不报错（原则 P2）。
 */
export function alignmentsOf(state: EditorState, table: SyntaxNode): ColumnAlign[] {
  const row = delimiterRowOf(table)
  if (!row) return []

  const text = state.doc.sliceString(row.from, row.to)
  const parts = text.split(PIPE)
  // 前导 / 收尾竖线会切出空片段，去掉它们才对得上列序号
  if (parts.length > 0 && (parts[0] as string).trim() === '') parts.shift()
  if (parts.length > 0 && (parts[parts.length - 1] as string).trim() === '') parts.pop()

  return parts.map((part) => {
    const cell = part.trim()
    if (!/^:?-+:?$/.test(cell)) return 'none'
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return 'none'
  })
}

/**
 * 光标是否落在这张表里（闭区间，跟行内元素的显形规则保持一致）。
 *
 * 判定粒度是**整张表**而不是单行 —— 局部显形会让那一行脱出匿名表格盒，
 * 把一张表劈成两张，列宽当场分家，比整体切换刺眼得多。
 */
export function tableIsActive(state: EditorState, table: SyntaxNode): boolean {
  for (const range of state.selection.ranges) {
    for (const pos of range.empty ? [range.head] : [range.from, range.to]) {
      if (pos >= table.from && pos <= table.to) return true
    }
  }
  return false
}
