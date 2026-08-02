/**
 * 表格编辑（docs/design/02 §6.4）。
 *
 * ## 关键决定：一份状态都不持有
 *
 * 「表格网格编辑器」当初被列进硬骨头，是因为通行做法是拿一个 widget 装表格，
 * 而 widget 里必然要存一份**第二状态**（选中的单元格、拖拽中的列、列宽），
 * 它和文本缓冲区必须始终同调。撤销、外部改文件、将来的协同都会打破同调 ——
 * 做浅了就是「编辑完表格按 ⌘Z 文档烂掉」。
 *
 * 这里绕开了整个问题：**每一条命令都是一次纯文本变换**。读文本、算出新文本、
 * 发一个普通 transaction。撤销、脏标记、外部改文件、协同因此全都自动正确 ——
 * 跟代码块语言选择器是同一个路子（03 §7.2）。
 *
 * 代价说清楚：**拖拽调列宽做不了**。它天生需要一份跨帧存活的拖拽状态，
 * 而那正是上面要避开的东西。列宽仍由浏览器按内容算（见 live-preview/tables.ts）。
 *
 * ## 重排是显式的
 *
 * Tab / Shift+Tab **只移动光标，不改文档** —— 纯导航不该在撤销栈里留下一步。
 * 只有结构性命令（增删行列、改对齐、格式化）才重排竖线。
 */
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type SelectionRange } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'
import { TABLE_NODES } from '@mosu/markdown'
import {
  alignmentsOf,
  delimiterRowOf,
  delimiterRowLayout,
  rowLayout,
} from './live-preview/tables.js'
import type { ColumnAlign } from './live-preview/tables.js'
import type { SyntaxNode } from '@lezer/common'

/** 单元格内容在文档里的范围（不含分界竖线，也不含两侧填充空格）。 */
interface Range {
  from: number
  to: number
}

/**
 * 表格的纯数据形态。
 *
 * `rows[0]` 是表头，之后是正文行。**分隔行不在其中** —— 它完全由 `aligns`
 * 决定，是派生物而不是数据。把它当成一行会让所有行号加一，而每一处「加一」
 * 都是一个将来会算错的地方。
 */
export interface TableModel {
  from: number
  to: number
  rows: string[][]
  aligns: ColumnAlign[]
  columns: number
  /**
   * 表格每一行前面的**块前缀** —— blockquote 的 `> `、列表项的缩进。
   *
   * 顶层表格是空串。存它是因为 `[from, to]` 这个区间只跳过了**首行**的前缀
   * （`table.from` 已经在它之后），却横跨了后续各行的前缀。重新序列化时
   * 不把它加回去，第二行往后就掉出 blockquote / 列表项了（issue #8）。
   *
   * 表现相当刺眼：一张 blockquote 里的表格按一下 Tab，左边的引用竖条消失，
   * `>` 变成了第一列的内容，三列变四列。
   */
  prefix: string
}

/** 光标所在的格子。`row` 为 `'delimiter'` 表示光标停在分隔行上。 */
export interface CellLocation {
  row: number | 'delimiter'
  column: number
}

/**
 * 单个字符的显示宽度。
 *
 * 中日韩文字占两格。不按显示宽度对齐的话，中文表格在源码模式下是彻底歪的 ——
 * 而这个项目的文档全是中文，那等于对齐功能根本不存在。
 *
 * 这是经典的 wcwidth 近似：组合符号、可变选择符、部分 emoji 序列算不准。
 * 算不准的后果只是竖线差一格，不影响正确性，不值得为它引一个依赖。
 */
function charWidth(code: number): number {
  if (code < 0x1100) return 1
  return (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1
}

export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0)
  return width
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

function enclosingTable(state: EditorState, pos: number, side: -1 | 1): SyntaxNode | null {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    node;
    node = node.parent
  ) {
    if (node.name === TABLE_NODES.table) return node
  }
  return null
}

/**
 * 光标所在的 Table 节点。不在表格里返回 null。
 *
 * 两侧都要试：`resolveInner(pos, -1)` 在表格**第一个字符之前**（比如光标停在
 * 文档开头而文档以表格起头）解析到的是表格外面的节点，于是「光标明明在表里」
 * 却找不到表。这类差一格的问题只在边界上出现，平时完全看不出来。
 */
export function tableAt(state: EditorState, pos: number): SyntaxNode | null {
  return enclosingTable(state, pos, -1) ?? enclosingTable(state, pos, 1)
}

function bodyRowsOf(table: SyntaxNode): SyntaxNode[] {
  const rows: SyntaxNode[] = []
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === TABLE_NODES.row) rows.push(child)
  }
  return rows
}

function headerOf(table: SyntaxNode): SyntaxNode | null {
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === TABLE_NODES.header) return child
  }
  return null
}

/**
 * 一行里各单元格的内容范围。
 *
 * 首尾竖线是可选的（`a | b` 也是合法 GFM），所以不能按竖线数量推列数，
 * 只能先判断首尾、再把中间的当分界。
 */
function contentRanges(
  state: EditorState,
  lineFrom: number,
  pipes: readonly number[],
): Range[] {
  const line = state.doc.lineAt(lineFrom)
  const firstNonSpace = line.from + (line.text.length - line.text.trimStart().length)
  /**
   * 单元格内容能从哪儿开始。
   *
   * 取**行节点的起点**与首个非空白位置里靠后的那个。只用 `firstNonSpace`
   * 是错的：blockquote 里 `> | a | b |` 的首个非空白字符是 `>`，首个竖线在
   * 它右边，于是 `[line.from, pipe0)` 也就是 `"> "` 被当成了第 0 个单元格
   * （issue #8）。而行节点（`TableHeader` / `TableRow`）的起点由解析器给出，
   * 本来就已经在 `QuoteMark` 和列表缩进之后了。
   */
  const contentStart = Math.max(lineFrom, firstNonSpace)

  let start = 0
  let end = pipes.length
  if (pipes.length > 0 && (pipes[0] as number) <= contentStart) start = 1

  const last = pipes[end - 1]
  const hasTrailing =
    last !== undefined && end > start && state.doc.sliceString(last + 1, line.to).trim() === ''
  if (hasTrailing) end -= 1

  const ranges: Range[] = []
  let cursor = start > 0 ? (pipes[0] as number) + 1 : contentStart
  for (let i = start; i < end; i++) {
    const pipe = pipes[i] as number
    ranges.push({ from: cursor, to: pipe })
    cursor = pipe + 1
  }
  ranges.push({ from: cursor, to: hasTrailing ? (last as number) : line.to })
  return ranges
}

function rowRanges(state: EditorState, row: SyntaxNode): Range[] {
  return contentRanges(state, row.from, rowLayout(state, row).pipes)
}

/** 去掉两侧填充后的内容范围 —— 光标要落在字上，不是落在空格上。 */
function trimmedRange(state: EditorState, range: Range): Range {
  const text = state.doc.sliceString(range.from, range.to)
  const lead = text.length - text.trimStart().length
  const tail = text.length - text.trimEnd().length
  const from = range.from + lead
  return { from, to: Math.max(from, range.to - tail) }
}

/**
 * 读出表格的纯数据形态。
 *
 * 列数取**所有行里最多的那一个**，而不是表头的列数。GFM 渲染时会把超出表头的
 * 单元格丢掉，于是那些字在预览里是看不见的 —— 但它们确实在文件里。
 * 按表头列数归一等于**静默删掉用户的字**（原则 P2），所以宁可把表头补宽。
 */
export function parseTable(state: EditorState, table: SyntaxNode): TableModel | null {
  const header = headerOf(table)
  if (!header) return null

  const rows: string[][] = []
  const read = (row: SyntaxNode): string[] =>
    rowRanges(state, row).map((r) => state.doc.sliceString(r.from, r.to).trim())

  rows.push(read(header))
  for (const row of bodyRowsOf(table)) rows.push(read(row))

  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const aligns = alignmentsOf(state, table)
  while (aligns.length < columns) aligns.push('none')

  // 首行的行首到表格起点之间就是块前缀：blockquote 的 `> `、列表项的缩进。
  // 顶层表格这一段是空的。
  const firstLine = state.doc.lineAt(table.from)
  const prefix = state.doc.sliceString(firstLine.from, table.from)

  return {
    from: table.from,
    to: table.to,
    rows,
    aligns: aligns.slice(0, columns),
    columns,
    prefix,
  }
}

/** 光标落在哪个格子。 */
export function locate(
  state: EditorState,
  table: SyntaxNode,
  pos: number,
): CellLocation | null {
  const delimiter = delimiterRowOf(table)
  if (delimiter && pos >= delimiter.from && pos <= delimiter.to) {
    const ranges = contentRanges(
      state,
      delimiter.from,
      delimiterRowLayout(state, delimiter).pipes,
    )
    const index = ranges.findIndex((r) => pos >= r.from && pos <= r.to)
    return { row: 'delimiter', column: Math.max(0, index) }
  }

  const header = headerOf(table)
  const candidates: SyntaxNode[] = header ? [header, ...bodyRowsOf(table)] : bodyRowsOf(table)
  for (const [index, row] of candidates.entries()) {
    if (pos < row.from || pos > row.to) continue
    const ranges = rowRanges(state, row)
    const column = ranges.findIndex((r) => pos >= r.from && pos <= r.to)
    return { row: index, column: Math.max(0, column) }
  }
  return null
}

const MIN_DELIMITER = 3

function delimiterCell(width: number, align: ColumnAlign): string {
  const inner = Math.max(MIN_DELIMITER, width)
  switch (align) {
    case 'left':
      return `:${'-'.repeat(inner - 1)}`
    case 'right':
      return `${'-'.repeat(inner - 1)}:`
    case 'center':
      return `:${'-'.repeat(inner - 2)}:`
    default:
      return '-'.repeat(inner)
  }
}

export interface SerializedTable {
  text: string
  /** 各单元格内容在**新文本里**的偏移，行序同 `TableModel.rows`。 */
  cells: Range[][]
}

/**
 * 把模型写回文本，顺便把竖线对齐。
 *
 * 每列宽度取该列最宽的内容（至少 3，分隔行要放得下 `---`）。
 * 对齐方式只影响分隔行的冒号，不影响单元格内部的填充方向 ——
 * 内容一律左靠，右靠会让中英混排的表格看起来更乱而不是更整齐。
 *
 * **块前缀要加回第二行往后的每一行。** 首行不加：`model.from` 已经在它之后。
 * 少了这一步，blockquote 里的表格重排一次就掉出 blockquote，
 * 列表里的表格丢掉缩进、当场不再是表格（issue #8）。
 */
export function serializeTable(model: TableModel): SerializedTable {
  const widths: number[] = []
  for (let column = 0; column < model.columns; column++) {
    let width = MIN_DELIMITER
    for (const row of model.rows) width = Math.max(width, displayWidth(row[column] ?? ''))
    widths.push(width)
  }

  const cells: Range[][] = []
  const lines: string[] = []
  // 换行 + 块前缀 —— 每换一行就要跨过这么多字符，单元格偏移得跟着算
  const gap = 1 + model.prefix.length
  let offset = 0

  const emit = (row: string[]): void => {
    const ranges: Range[] = []
    let text = '|'
    for (let column = 0; column < model.columns; column++) {
      const value = row[column] ?? ''
      text += ' '
      ranges.push({ from: offset + text.length, to: offset + text.length + value.length })
      text += `${pad(value, widths[column] as number)} |`
    }
    lines.push(text)
    cells.push(ranges)
    offset += text.length + gap
  }

  emit(model.rows[0] ?? [])

  // 分隔行紧跟表头，且不进 cells —— 它是派生物，没有「光标应该落在哪」的语义
  let delimiterText = '|'
  for (let column = 0; column < model.columns; column++) {
    delimiterText += ` ${delimiterCell(widths[column] as number, model.aligns[column] ?? 'none')} |`
  }
  lines.push(delimiterText)
  offset += delimiterText.length + gap

  for (const row of model.rows.slice(1)) emit(row)

  return { text: lines.join(`\n${model.prefix}`), cells }
}

/** 把模型写回文档，并把光标放进指定格子。 */
function applyModel(
  view: EditorView,
  model: TableModel,
  target: { row: number; column: number } | null,
): boolean {
  const { text, cells } = serializeTable(model)
  const current = view.state.doc.sliceString(model.from, model.to)

  let selection: SelectionRange | undefined
  if (target) {
    const range = cells[target.row]?.[target.column]
    // 落在内容末尾而不是选中内容：结构性操作之后用户多半是要**接着敲**，
    // 选中会让下一个字符把刚填的内容顶掉
    if (range) selection = EditorSelection.cursor(model.from + range.to)
  }

  // 内容没变且不需要挪光标时什么都不做 —— 别在撤销栈里留一步空操作
  if (current === text && !selection) return false

  view.dispatch({
    changes: current === text ? [] : { from: model.from, to: model.to, insert: text },
    ...(selection ? { selection: EditorSelection.create([selection]) } : {}),
    scrollIntoView: true,
    userEvent: 'input.mosu.table',
  })
  return true
}

/** 命令的公共开头：不在表格里就交还给别人处理。 */
function withTable(
  view: EditorView,
  run: (model: TableModel, location: CellLocation, table: SyntaxNode) => boolean,
): boolean {
  const pos = view.state.selection.main.head
  const table = tableAt(view.state, pos)
  if (!table) return false
  const model = parseTable(view.state, table)
  const location = model ? locate(view.state, table, pos) : null
  if (!model || !location) return false
  return run(model, location, table)
}

/** 分隔行上的光标按「表头」算：列相关的操作在那儿的语义是一样的。 */
function rowIndexOf(location: CellLocation): number {
  return location.row === 'delimiter' ? 0 : location.row
}

/**
 * 把光标移到已存在的格子里 —— **不改文档**。
 *
 * 目标格子在文本里不存在（这一行的单元格比别人少）时返回 false，
 * 交给调用方走重排那条路，顺便把这一行补齐。
 */
function moveTo(view: EditorView, table: SyntaxNode, row: number, column: number): boolean {
  const header = headerOf(table)
  const nodes = header ? [header, ...bodyRowsOf(table)] : bodyRowsOf(table)
  const node = nodes[row]
  if (!node) return false

  const ranges = rowRanges(view.state, node)
  const range = ranges[column]
  if (!range) return false

  const { from, to } = trimmedRange(view.state, range)
  view.dispatch({
    // 选中内容而不是只放光标：Tab 过去接着敲就是替换，这是表格导航的通行语义
    selection: EditorSelection.range(from, to),
    scrollIntoView: true,
  })
  return true
}

function emptyRow(columns: number): string[] {
  return Array.from({ length: columns }, () => '')
}

/** Tab：下一个格子。走到最后一格时新起一行 —— 这是搭表格最顺手的方式。 */
export const tableNextCell: Command = (view) =>
  withTable(view, (model, location, table) => {
    const row = rowIndexOf(location)
    // 分隔行上按 Tab 直接去正文第一格，不在分隔行里横向走
    let nextRow = location.row === 'delimiter' ? 1 : row
    let nextColumn = location.row === 'delimiter' ? 0 : location.column + 1
    if (nextColumn >= model.columns) {
      nextRow += 1
      nextColumn = 0
    }

    if (nextRow < model.rows.length && moveTo(view, table, nextRow, nextColumn)) return true

    // 目标不存在（走到表尾，或这一行短了一截）：补出来再落点
    while (model.rows.length <= nextRow) model.rows.push(emptyRow(model.columns))
    return applyModel(view, model, { row: nextRow, column: nextColumn })
  })

/** Shift+Tab：上一个格子。已经在第一格时原地不动 —— 绝不能落回去缩进表头。 */
export const tablePrevCell: Command = (view) =>
  withTable(view, (model, location, table) => {
    const row = rowIndexOf(location)
    let prevRow = row
    let prevColumn = location.row === 'delimiter' ? model.columns - 1 : location.column - 1
    if (location.row === 'delimiter') prevRow = 0
    else if (prevColumn < 0) {
      prevRow -= 1
      prevColumn = model.columns - 1
    }
    if (prevRow < 0) return true

    if (moveTo(view, table, prevRow, prevColumn)) return true
    return applyModel(view, model, { row: prevRow, column: prevColumn })
  })

/**
 * 回车：去下一行。
 *
 * **只在下一行已经存在时接管，表尾一律交还给默认行为。** 这条边界是被真实用法
 * 逼出来的：手敲一张表就是「敲完一行按回车、再敲下一行」，如果回车在表尾替用户
 * 长出一个空行并把光标塞进第一格，接着敲的 `| 1 | 2 |` 就插进了那个格子里，
 * 得到一堆嵌套的竖线。想加一行的用户有 Tab（末格按 Tab 就长一行），
 * 手敲的用户则完全不受打扰。
 *
 * 最后一行是空行时，删掉它并在表格后另起一段。没有这条的话，用 Tab 长出空行的
 * 用户会被困在表格里，只能靠方向键逃出去。这跟空列表项回车退出列表是同一个
 * 直觉（02 §7）。
 */
export const tableNextRow: Command = (view) =>
  withTable(view, (model, location, table) => {
    const row = rowIndexOf(location)
    const isLast = row === model.rows.length - 1
    const rowIsEmpty = (model.rows[row] ?? []).every((cell) => cell === '')

    if (location.row !== 'delimiter' && isLast && row > 0 && rowIsEmpty) {
      model.rows.splice(row, 1)
      const { text } = serializeTable(model)
      // **两个换行，不是一个。** GFM 里表格行之后紧邻的非空行**仍然是表格行**，
      // 所以只补一个 `\n` 的话，用户刚被送出表格，敲的第一个字又把自己送了
      // 回去 —— 连刚删掉的那一空行也一并回来（issue #10）。
      // 中间那个空行才是「这里是一个新段落」的分界。
      const exit = `${text}\n\n`
      view.dispatch({
        changes: { from: model.from, to: model.to, insert: exit },
        selection: EditorSelection.cursor(model.from + exit.length),
        scrollIntoView: true,
        userEvent: 'input.mosu.table',
      })
      return true
    }

    const nextRow = location.row === 'delimiter' ? 1 : row + 1
    if (nextRow < model.rows.length) {
      // 目标格在文本里不存在（这一行短了一截）时才重排，顺便把它补齐
      if (moveTo(view, table, nextRow, 0)) return true
      return applyModel(view, model, { row: nextRow, column: 0 })
    }
    return false
  })

function insertRow(offset: 0 | 1): Command {
  return (view) =>
    withTable(view, (model, location) => {
      // 表头不能有「上面一行」—— GFM 的表头必须是第一行
      const at = Math.max(1, rowIndexOf(location) + offset)
      model.rows.splice(at, 0, emptyRow(model.columns))
      return applyModel(view, model, { row: at, column: 0 })
    })
}

export const tableInsertRowAbove = insertRow(0)
export const tableInsertRowBelow = insertRow(1)

function insertColumn(offset: 0 | 1): Command {
  return (view) =>
    withTable(view, (model, location) => {
      const at = Math.min(model.columns, location.column + offset)
      for (const row of model.rows) row.splice(at, 0, '')
      model.aligns.splice(at, 0, 'none')
      model.columns += 1
      return applyModel(view, model, { row: rowIndexOf(location), column: at })
    })
}

export const tableInsertColumnBefore = insertColumn(0)
export const tableInsertColumnAfter = insertColumn(1)

/**
 * 删除当前行。
 *
 * 删表头时把第一条正文行顶上来 —— GFM 的表格必须有表头，直接删掉会得到一张
 * 语法上不成立的表。整张表只剩表头时拒绝执行：那时候用户想要的是删掉整张表，
 * 而那件事该由他自己选中删除，不该由一条「删除行」命令替他决定。
 */
export const tableDeleteRow: Command = (view) =>
  withTable(view, (model, location) => {
    if (location.row === 'delimiter') return false
    if (model.rows.length <= 1) return false
    model.rows.splice(location.row, 1)
    const target = Math.min(location.row, model.rows.length - 1)
    return applyModel(view, model, { row: target, column: location.column })
  })

/** 删除当前列。只剩一列时拒绝 —— 那等于删掉整张表，同上不替用户做决定。 */
export const tableDeleteColumn: Command = (view) =>
  withTable(view, (model, location) => {
    if (model.columns <= 1) return false
    for (const row of model.rows) row.splice(location.column, 1)
    model.aligns.splice(location.column, 1)
    model.columns -= 1
    const target = Math.min(location.column, model.columns - 1)
    return applyModel(view, model, { row: rowIndexOf(location), column: target })
  })

/** 设置当前列的对齐方式。改的是分隔行里的冒号 —— 仍然只是文本。 */
export function tableAlignColumn(align: ColumnAlign): Command {
  return (view) =>
    withTable(view, (model, location) => {
      model.aligns[location.column] = align
      return applyModel(view, model, { row: rowIndexOf(location), column: location.column })
    })
}

/** 重排竖线。手敲出来的表格靠它一键对齐。 */
export const tableFormat: Command = (view) =>
  withTable(view, (model, location) =>
    applyModel(view, model, { row: rowIndexOf(location), column: location.column }),
  )

/**
 * 在光标处插入一张空表。
 *
 * 不在表格里才有意义；已经在表格里时返回 false，免得嵌出一张不成立的表。
 */
export function tableInsert(rows: number, columns: number): Command {
  return (view) => {
    const { state } = view
    const pos = state.selection.main.head
    if (tableAt(state, pos)) return false

    const line = state.doc.lineAt(pos)
    // 光标所在行的块前缀 —— 在 blockquote 里插表，表格的每一行都得带上 `> `，
    // 否则第二行就掉出去了（跟 issue #8 是同一件事的另一个入口）。
    // 只认 `>` 与空白：列表的 `- ` 不算前缀，它是内容的一部分。
    const prefix = /^[ \t>]*/.exec(line.text)?.[0] ?? ''

    const model: TableModel = {
      from: pos,
      to: pos,
      rows: Array.from({ length: Math.max(1, rows) }, () => emptyRow(Math.max(1, columns))),
      aligns: Array.from({ length: Math.max(1, columns) }, () => 'none' as ColumnAlign),
      columns: Math.max(1, columns),
      prefix,
    }
    const { text, cells } = serializeTable(model)

    // 表格必须自成一块：前面有字就先换行，否则会被当成段落的一部分
    const lead = line.text.slice(0, pos - line.from).trim() === '' ? '' : `\n${prefix}`
    const suffix = '\n'
    const at = pos + lead.length

    view.dispatch({
      changes: { from: pos, insert: lead + text + suffix },
      selection: EditorSelection.cursor(at + (cells[0]?.[0]?.from ?? 0)),
      scrollIntoView: true,
      userEvent: 'input.mosu.table',
    })
    return true
  }
}
