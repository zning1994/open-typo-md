/**
 * 内核自带的基础样式。
 *
 * 定位：只负责「结构性」的呈现（标题多大、引用有条边线、代码块有底色），
 * 一切颜色和字体都走 CSS 变量，由主题层覆盖（docs/design/05）。
 * M4 的主题引擎会接管配色，这里的默认值只是让 M1 能看。
 */
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'
import { mathTheme } from './math.js'

const v = (name: string, fallback: string) => `var(--typo-${name}, ${fallback})`

export const baseTheme = EditorView.theme({
  '&': {
    color: v('fg', '#24292f'),
    backgroundColor: v('bg', '#ffffff'),
    fontSize: v('font-size', '16px'),
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: v('font-body', 'system-ui, -apple-system, "PingFang SC", sans-serif'),
    lineHeight: v('line-height', '1.7'),
    overflow: 'auto',
  },
  '.cm-content': {
    maxWidth: v('content-width', '42em'),
    margin: '0 auto',
    padding: '3rem 1.5rem 40vh 1.5rem',
    caretColor: v('cursor', '#24292f'),
  },
  '.cm-line': { padding: '0' },

  // —— 标题 ——
  '.cm-typo-heading': { fontWeight: '600', lineHeight: '1.3' },
  '.cm-typo-h1': { fontSize: '1.9em', margin: '0.9em 0 0.4em' },
  '.cm-typo-h2': { fontSize: '1.55em', margin: '0.85em 0 0.35em' },
  '.cm-typo-h3': { fontSize: '1.3em', margin: '0.8em 0 0.3em' },
  '.cm-typo-h4': { fontSize: '1.12em', margin: '0.75em 0 0.3em' },
  '.cm-typo-h5': { fontSize: '1em', margin: '0.7em 0 0.3em' },
  '.cm-typo-h6': {
    fontSize: '0.94em',
    color: v('fg-muted', '#6e7781'),
    margin: '0.7em 0 0.3em',
  },

  // —— 行内 ——
  '.cm-typo-strong': { fontWeight: '700' },
  '.cm-typo-em': { fontStyle: 'italic' },
  '.cm-typo-strike': { textDecoration: 'line-through', opacity: '0.7' },
  '.cm-typo-code-inline': {
    fontFamily: v('font-mono', 'ui-monospace, Menlo, Consolas, monospace'),
    fontSize: '0.92em',
    backgroundColor: v('code-bg', '#f0f2f4'),
    borderRadius: '4px',
    padding: '0.1em 0.32em',
  },
  '.cm-typo-link': { color: v('accent', '#0969da'), textDecoration: 'underline' },

  // 显形中的 Markdown 标记：看得见，但不抢戏
  '.cm-typo-mark': { color: v('marker-fg', '#b0b6bd'), fontWeight: 'normal' },
  '.cm-typo-list-number': { color: v('marker-fg', '#b0b6bd') },
  '.cm-typo-bullet': { color: v('marker-fg', '#b0b6bd') },

  // —— 块级 ——
  '.cm-typo-quote': {
    borderLeft: `3px solid ${v('border', '#d0d7de')}`,
    paddingLeft: '1em',
    color: v('fg-muted', '#6e7781'),
  },
  '.cm-typo-code-block': {
    fontFamily: v('font-mono', 'ui-monospace, Menlo, Consolas, monospace'),
    fontSize: '0.9em',
    backgroundColor: v('code-bg', '#f0f2f4'),
    // 代码不跟着散文折行：缩进结构靠列对齐传达信息，一折就读不出层级。
    // 这里设在 .cm-line 上，直接覆盖掉 .cm-content 继承下来的 pre-wrap
    // （不同元素之间是继承关系，不存在选择器优先级之争）。
    whiteSpace: 'pre',
    overflowX: 'auto',
    // 滚动条必须看得见。
    //
    // 起初为了「每行一条滚动条太吵」把它藏了，那是个错误的取舍：
    // 藏掉之后既没有可拖动的东西，也没有「这里还有内容」的提示，
    // 用不带横向滚轮的鼠标就彻底滚不动了。能用优先于好看。
    scrollbarWidth: 'thin',
  },
  '.cm-typo-code-block::-webkit-scrollbar': { height: '6px' },
  '.cm-typo-code-block::-webkit-scrollbar-thumb': {
    backgroundColor: v('border', '#d0d7de'),
    borderRadius: '3px',
  },
  '.cm-typo-code-block::-webkit-scrollbar-track': { background: 'transparent' },

  // 围栏被藏起来时，在代码块首行右上角标出语言。
  // 同时补回上下留白 —— 藏围栏用的是「与上一行合并」，会顺带吃掉块前的空行
  '.cm-typo-code-first': { position: 'relative', marginTop: '0.9em', paddingTop: '0.4em' },
  '.cm-typo-code-block:not(:has(+ .cm-typo-code-block))': {
    marginBottom: '0.9em',
    paddingBottom: '0.4em',
  },
  // 语言选择器：绝对定位飘在右上角，**不占行内空间**，
  // 否则代码首行会被它顶得往右缩一截
  '.cm-typo-code-lang': {
    position: 'absolute',
    top: '0.1em',
    right: '0.4em',
    zIndex: '1',
    appearance: 'none',
    border: '1px solid transparent',
    borderRadius: '4px',
    background: 'transparent',
    color: v('fg-muted', '#6e7781'),
    font: 'inherit',
    fontSize: '0.75em',
    lineHeight: '1.6',
    padding: '0 0.3em',
    cursor: 'pointer',
    userSelect: 'none',
    // 平时几乎隐形，鼠标进入代码块才显出可点的样子 —— 它是辅助控件，
    // 不该跟代码本身抢注意力
    opacity: '0.55',
    transition: 'opacity 120ms, border-color 120ms',
  },
  '.cm-typo-code-block:hover .cm-typo-code-lang, .cm-typo-code-lang:focus': {
    opacity: '1',
    borderColor: v('border', '#d0d7de'),
  },
  // —— 表格 ——
  //
  // 没有 widget、没有第二状态：表格仍然是文本，只是靠 CSS 摆成表格的样子。
  // `.cm-content` 不是 display:table，但 CSS 2.1 规定非表格父元素下**连续的**
  // table-row 会被自动包进一个匿名表格盒 —— 于是连续的表格行自成一张表，
  // 中间夹一行普通段落就自然断开。详见 live-preview/tables.ts 的说明。
  '.cm-typo-tr': {
    display: 'table-row',
    // 表格里的内容不跟着散文折行：一折，列宽就失去参考意义
    whiteSpace: 'pre',
  },
  '.cm-typo-td': {
    display: 'table-cell',
    padding: '0.28em 0.7em',
    borderBottom: `1px solid ${v('border', '#d0d7de')}`,
    verticalAlign: 'top',
  },
  '.cm-typo-tr-head .cm-typo-td': {
    fontWeight: '600',
    borderBottom: `2px solid ${v('border-strong', '#afb8c1')}`,
  },
  // 分隔行平时是藏起来的（blocks.ts）；光标进表格时露出来，
  // 此刻它也必须是表格行，否则匿名表格盒会被它截成两张，列宽当场分家
  '.cm-typo-tr-delim .cm-typo-td': {
    color: v('marker-fg', '#b0b6bd'),
    padding: '0 0.7em',
    borderBottom: 'none',
  },
  '.cm-typo-td-center': { textAlign: 'center' },
  '.cm-typo-td-right': { textAlign: 'right' },
  '.cm-typo-td-left': { textAlign: 'left' },

  // —— YAML front matter ——
  // 弱化成「这是元数据，不是正文」的样子：等宽、小一号、左侧一条边线。
  // 不藏起来 —— 它是内容，用户要能看见和改（跟有序列表编号同一条理由）
  '.cm-typo-frontmatter': {
    fontFamily: v('font-mono', 'ui-monospace, Menlo, Consolas, monospace'),
    fontSize: '0.85em',
    color: v('fg-muted', '#6e7781'),
    backgroundColor: v('code-bg', '#f0f2f4'),
    borderLeft: `3px solid ${v('border', '#d0d7de')}`,
    paddingLeft: '0.8em',
  },

  // —— 任务列表 ——
  '.cm-typo-task': {
    verticalAlign: 'middle',
    margin: '0 0.35em 0.15em 0',
    cursor: 'pointer',
  },

  // —— 脚注 ——
  // 引用做成上标；标签本身保持可见 —— 它是内容（「第几条」），不是纯标记
  '.cm-typo-footnote-ref': {
    verticalAlign: 'super',
    fontSize: '0.78em',
    color: v('accent', '#0969da'),
  },
  '.cm-typo-footnote-def': {
    fontSize: '0.92em',
    color: v('fg-muted', '#6e7781'),
  },

  '.cm-typo-hr-line': { display: 'flex', alignItems: 'center', minHeight: '1.7em' },
  '.cm-typo-hr': {
    display: 'inline-block',
    width: '100%',
    borderTop: `1px solid ${v('border', '#d0d7de')}`,
    verticalAlign: 'middle',
  },

  // 显形中的公式源码：等宽，跟正文区分开
  '.cm-typo-math-source': {
    fontFamily: v('font-mono', 'ui-monospace, Menlo, Consolas, monospace'),
    fontSize: '0.92em',
    color: v('fg-muted', '#6e7781'),
  },

  // —— 图片 ——
  '.cm-typo-image img': { maxWidth: '100%', borderRadius: '4px', verticalAlign: 'bottom' },
  '.cm-typo-image--broken': {
    fontFamily: v('font-mono', 'monospace'),
    fontSize: '0.9em',
    color: v('danger', '#cf222e'),
    textDecoration: 'underline wavy',
  },
  '.cm-typo-image-source': { color: v('fg-muted', '#6e7781') },

  '.cm-selectionBackground, ::selection': { backgroundColor: v('selection', '#b4d5fe') },
  '.cm-focused .cm-selectionBackground': { backgroundColor: v('selection', '#b4d5fe') },

  // 无障碍：尊重系统的「减少动态效果」设置（docs/design/07 §3）
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-scroller': { scrollBehavior: 'auto' },
  },
})

/**
 * 语法高亮 —— 主要服务于源码模式与代码块内部。
 * 实时预览下大部分行内样式已由装饰接管，这里只补没被装饰覆盖的部分。
 */
export const markdownHighlight = HighlightStyle.define([
  { tag: tags.processingInstruction, color: v('marker-fg', '#b0b6bd') },
  { tag: tags.keyword, color: v('accent', '#0969da') },
  { tag: tags.comment, color: v('fg-muted', '#6e7781'), fontStyle: 'italic' },
  { tag: tags.string, color: v('string-fg', '#0a3069') },
  { tag: tags.number, color: v('number-fg', '#0550ae') },
  { tag: tags.typeName, color: v('type-fg', '#953800') },
  { tag: tags.variableName, color: v('fg', '#24292f') },
  { tag: tags.url, color: v('accent', '#0969da') },
])

export function typoTheme(): Extension {
  return [baseTheme, mathTheme, syntaxHighlighting(markdownHighlight)]
}
