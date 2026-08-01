/**
 * 「哪些语法标记该显形」的判定。
 *
 * 这是实时预览手感的核心规则（见 docs/design/02-editor-core.md §3）。
 * 规则定错了，编辑器就会在两种方式上让人难受：该显形时不显形（改不动），
 * 或者不该显形时乱显形（文字横跳）。
 */
import type { EditorState } from '@codemirror/state'

export interface ActiveState {
  /** 参与判定的「光标点」。 */
  points: readonly number[]
  /** 这些点所在的行号（1-based）。 */
  lines: ReadonlySet<number>
}

/**
 * 用**选区的端点**（而不是整个选区跨度）来判定激活。
 *
 * 为什么：如果按整个跨度算，Ctrl+A 全选会让整篇文档瞬间变成源码，非常刺眼；
 * 鼠标拖选一大段也会同样炸开。用端点算的话，全选只会让首尾两行显形，
 * 而「把光标放到某个词里去改」这个高频动作依然精确命中。
 *
 * 多光标时每个光标独立贡献端点，取并集。
 */
export function activeState(state: EditorState): ActiveState {
  const points: number[] = []
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    for (const pos of range.empty ? [range.head] : [range.from, range.to]) {
      points.push(pos)
      lines.add(state.doc.lineAt(pos).number)
    }
  }
  return { points, lines }
}

/**
 * 行内元素的激活判定：光标点落在 [from, to] **闭区间**内即算激活。
 *
 * 闭区间很关键 —— 光标停在 `**粗体**` 紧右侧时也必须显形，
 * 否则用户没法在加粗内容的结尾继续输入（那是最常见的操作之一）。
 */
export function revealsRange(active: ActiveState, from: number, to: number): boolean {
  for (const p of active.points) {
    if (p >= from && p <= to) return true
  }
  return false
}

/**
 * 块级前缀（`#`、`>`、列表标记）的激活判定：按**行**为粒度。
 *
 * 为什么不用闭区间：标题的 `# ` 在行首，若按字符区间算，光标在标题中间时
 * `# ` 会被隐藏、移到行首又显形，整行文字左右横跳。按行算就稳定了。
 */
export function revealsLine(active: ActiveState, lineNumber: number): boolean {
  return active.lines.has(lineNumber)
}
