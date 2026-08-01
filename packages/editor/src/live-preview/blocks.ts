/**
 * 块级装饰。
 *
 * 跟 build.ts 分开的原因是 CodeMirror 的一条硬性约束：**会改变行结构的装饰
 * （块级 widget、跨越换行的 replace）必须由 StateField 提供，不能来自
 * ViewPlugin** —— 视口计算需要提前拿到它们。build.ts 里那套走的是 ViewPlugin，
 * 只能做不跨行的行内装饰。
 *
 * 目前用它来藏围栏代码块的 ``` 行。M2 的表格 widget 会复用同一套机制。
 *
 * 代价要说清楚：StateField 拿不到视口，只能遍历整棵语法树。代码围栏在文档里
 * 数量有限，暂时不构成问题；等块级装饰的种类多起来（表格、公式、图表），
 * 需要改成按变更范围增量更新。
 */
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import {
  BLOCK_NODES,
  MATH_NODES,
  TABLE_NODES,
  codeLanguageNames,
  resolveCodeLanguage,
} from '@typo/markdown'
import { MathWidget } from '../math.js'
import { MermaidWidget } from '../mermaid.js'
import { CodeLanguageWidget } from './widgets.js'
import { delimiterRowOf, tableIsActive } from './tables.js'

/**
 * 整行隐藏。
 *
 * 范围必须**连一个换行符一起盖**，否则行还在、只是变空，比不藏更难看
 * （Setext 标题就是栽在这上面）。
 *
 * 但盖哪一侧的换行大有讲究 —— 这是实测出来的坑：
 *
 * - 盖**后面**那个换行（`[line.from, line.to + 1)`）会让这一行和**下一行**
 *   合并成一个视觉行，而合并后的行锚定在被替换区间的起点上，
 *   于是下一行自己的行装饰（代码块底色、语言角标）位置落进了被替换的范围里，
 *   **整个被丢弃**。表现就是代码块第一行突然没了样式。
 * - 盖**前面**那个换行（`[line.from - 1, line.to)`）则是跟**上一行**合并，
 *   锚点还在上一行，谁的装饰都不受影响。
 *
 * 所以一律往前合并。文档**以代码块开头**时没有「前一个换行」可用 ——
 * 这种情况下宁可不藏开围栏，也不走会破坏样式的往后合并（原则 P2：
 * 降级要优雅，不能为了藏一行标记把整行内容的呈现搞坏）。
 */
const HIDE_LINE = Decoration.replace({ block: true })

/** 代码块首行的行装饰 —— 给语言选择器提供定位参照（position: relative）。 */
const CODE_FIRST_LINE = Decoration.line({ class: 'cm-typo-code-first' })

/**
 * 语言清单只算一次。
 *
 * 它有一百多项，而块级装饰在**每次选区变化**时都会重算整棵树；
 * 每次重建一遍数组既浪费，也会让 widget 的 `eq()` 永远为假、
 * 导致下拉框在用户展开它的瞬间被重建。
 */
const LANGUAGE_CHOICES: readonly string[] = codeLanguageNames()

/**
 * 语言选择器。
 *
 * 挂在代码内容首行的**行首**（`side: -1`），但靠 CSS 绝对定位飘到右上角，
 * 不占据任何行内空间 —— 否则代码会被它顶得往右缩一截。
 */
function langPicker(info: string): Decoration {
  return Decoration.widget({
    widget: new CodeLanguageWidget(resolveCodeLanguage(info) ?? info.trim(), LANGUAGE_CHOICES),
    side: -1,
  })
}

/**
 * 藏掉表格的分隔行（`| --- | :---: |`）。
 *
 * 它是纯语法噪声：既不是内容，也不像围栏那样是「删掉块的唯一抓手」——
 * 表格没了分隔行就不再是表格，用户想拆表直接删行即可。
 *
 * 光标进入表格时整条露出来（跟围栏代码块同一条规则）。露出来之后它由
 * build.ts 摆成一个正常的表格行，否则它会以块级行的身份把匿名表格盒截成两张。
 *
 * 隐藏范围往前合并（吃掉上一行的换行符），理由见 HIDE_LINE 的说明。
 * 分隔行必定跟在表头行后面，`from > 0` 恒成立，不存在文档开头那个退化情形。
 */
function hideDelimiterRow(
  state: EditorState,
  table: SyntaxNode,
  ranges: Range<Decoration>[],
): void {
  if (tableIsActive(state, table)) return

  const row = delimiterRowOf(table)
  if (!row) return

  const line = state.doc.lineAt(row.from)
  // 表头行是必须的，分隔行不可能是文档第一行；真遇上了（解析器容错）就不藏
  if (line.from === 0) return
  ranges.push(HIDE_LINE.range(line.from - 1, line.to))
}

/**
 * 块级公式：整块换成渲染结果。
 *
 * 跟藏围栏不同，这里是**整块替换**（`[block.from, block.to)` 正好覆盖若干整行），
 * 不需要往前吃换行那套技巧 —— 那个技巧是为「藏掉一行、把剩下的行接起来」
 * 准备的，而这里没有剩下的行。
 *
 * 光标进块即还原成源码：公式写错了总得能改，而且 `$$` 是删掉整块的唯一抓手。
 */
function renderBlockMath(
  state: EditorState,
  node: SyntaxNode,
  ranges: Range<Decoration>[],
): void {
  for (const range of state.selection.ranges) {
    for (const pos of range.empty ? [range.head] : [range.from, range.to]) {
      if (pos >= node.from && pos <= node.to) return // 闭区间，跟行内元素一致
    }
  }

  const first = state.doc.lineAt(node.from)
  const last = state.doc.lineAt(node.to)
  // 只有开围栏、没有内容：渲染出来是个空盒子，不如留着源码
  if (last.number - first.number < 1) return

  const tex = state.doc.sliceString(first.to + 1, closingFrom(state, node, last)).trim()
  if (!tex) return

  ranges.push(
    Decoration.replace({ block: true, widget: new MathWidget(tex, true) }).range(
      node.from,
      node.to,
    ),
  )
}

/** 内容的结束位置：有收尾 `$$` 就到它前面，没有就到块尾。 */
function closingFrom(state: EditorState, node: SyntaxNode, last: { from: number }): number {
  const closes = /^\s*\$\$\s*$/.test(state.doc.lineAt(last.from).text)
  return closes ? Math.max(node.from, last.from - 1) : node.to
}

/** 认得的图表语言。目前只有 mermaid；将来加 plantuml 之类从这里扩。 */
function resolveDiagram(info: string): boolean {
  return info.trim().toLowerCase() === 'mermaid'
}

/**
 * 图表块：整块换成渲染结果。
 *
 * 跟块级公式同一个形状，包括「光标进块即还原成源码」——
 * 图画错了总得能改，而围栏是删掉整块的唯一抓手。
 */
function renderDiagram(
  state: EditorState,
  node: SyntaxNode,
  firstLine: { number: number; to: number },
  lastLine: { number: number; from: number; text: string },
  ranges: Range<Decoration>[],
): void {
  const closes = /^\s*[`~]{3,}\s*$/.test(lastLine.text)
  const contentEnd = closes ? Math.max(firstLine.to, lastLine.from - 1) : node.to
  const code = state.doc.sliceString(firstLine.to + 1, contentEnd).trim()
  if (!code) return // 空图渲染出来是个空盒子，不如留着源码

  ranges.push(
    Decoration.replace({ block: true, widget: new MermaidWidget(code) }).range(
      node.from,
      node.to,
    ),
  )
}

function computeBlockDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const doc = state.doc
  const tree = syntaxTree(state)

  // 光标所在位置：落在某个代码块里，那个块的围栏就要显形
  const cursors = state.selection.ranges.map((r) => r.head)

  tree.iterate({
    enter(node) {
      if (node.name === TABLE_NODES.table) {
        hideDelimiterRow(state, node.node, ranges)
        return
      }
      if (node.name === MATH_NODES.block) {
        renderBlockMath(state, node.node, ranges)
        return false // 块内不再下钻：里面的 `$$` 标记由整块替换一起接管
      }
      if (node.name !== BLOCK_NODES.fencedCode) return

      const from = node.from
      const to = node.to
      // 闭区间：光标贴在围栏边上也算「在块内」，跟行内元素的规则保持一致
      const active = cursors.some((pos) => pos >= from && pos <= to)

      const firstLine = doc.lineAt(from)
      const lastLine = doc.lineAt(to)
      if (firstLine.number === lastLine.number) return // 单行的残缺围栏，不动它

      // 语言名：``` 后面那截
      const info = firstLine.text.replace(/^\s*[`~]+/, '').trim()

      if (active) {
        // 显形状态下不藏，只给首行挂角标（此时角标是多余的，去掉更干净）
        return
      }

      // ```mermaid：整块换成图。放在藏围栏之前 —— 一旦渲染成图，
      // 围栏和内容一起消失，下面那套「藏围栏 + 留内容」就不适用了
      if (resolveDiagram(info)) {
        renderDiagram(state, node.node, firstLine, lastLine, ranges)
        return false
      }

      const closes = /^\s*[`~]{3,}\s*$/.test(lastLine.text)
      // 没有内容行的空代码块（```js 紧跟 ```）藏了会只剩一条底色，没意义
      const hasContent = lastLine.number - firstLine.number >= (closes ? 2 : 1)
      if (!hasContent) return

      // 开围栏：往前合并（见 HIDE_LINE 的说明）。
      // 文档开头没得合并，那就不藏 —— 往后合并会把内容首行的样式整个抹掉
      if (firstLine.from > 0) {
        ranges.push(HIDE_LINE.range(firstLine.from - 1, firstLine.to))
      }

      // 闭围栏：同样往前合并，锚点留在最后一行内容上
      if (closes) {
        ranges.push(HIDE_LINE.range(lastLine.from - 1, lastLine.to))
      }

      // 内容首行挂行装饰 + 语言选择器
      const contentFirst = doc.line(firstLine.number + 1)
      ranges.push(CODE_FIRST_LINE.range(contentFirst.from))
      ranges.push(langPicker(info).range(contentFirst.from))
    },
  })

  return Decoration.set(ranges, true)
}

const blockDecorations = StateField.define<DecorationSet>({
  create: computeBlockDecorations,
  update(value, tr) {
    // 选区变化也要重算：光标进出代码块决定围栏藏不藏
    if (!tr.docChanged && !tr.selection) return value.map(tr.changes)
    return computeBlockDecorations(tr.state)
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function blockPreview(): Extension {
  return blockDecorations
}

export { computeBlockDecorations }
