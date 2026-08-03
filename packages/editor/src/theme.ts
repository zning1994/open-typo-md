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
import { mermaidTheme } from './mermaid.js'

const v = (name: string, fallback: string) => `var(--mosu-${name}, ${fallback})`

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
  //
  // 上下留白用 **padding**，不能用 margin（issue #34）。
  //
  // CodeMirror 的高度表逐行取 `getBoundingClientRect().height`，而那个数
  // **不含 margin**。行在 DOM 里因此比高度表以为的占得多，误差沿着视口
  // 从上往下累加 —— `posAtCoords` 走的正是高度表，于是鼠标点在这一行、
  // 光标落到下面一两行去。长文里标题多，累加得最快，报告就是这么来的。
  //
  // 这条规则对**任何** `.cm-line` 上的纵向留白都成立：能用 padding 就用
  // padding，需要留白落在背景色之外时用透明 border（见下面的代码块），
  // 唯独不能用 margin。`e2e/long-doc-coords.spec.ts` 钉着它。
  //
  // 代价是相邻标题之间的留白不再折叠（`# A` 紧跟 `# B` 时从 0.9em 变成
  // 1.3em），Setext 标题的下划线与正文之间同理。多出来的那点空白远比
  // 「点哪儿光标不落哪儿」便宜。
  '.cm-mosu-heading': { fontWeight: '600', lineHeight: '1.3' },
  '.cm-mosu-h1': { fontSize: '1.9em', padding: '0.9em 0 0.4em' },
  '.cm-mosu-h2': { fontSize: '1.55em', padding: '0.85em 0 0.35em' },
  '.cm-mosu-h3': { fontSize: '1.3em', padding: '0.8em 0 0.3em' },
  '.cm-mosu-h4': { fontSize: '1.12em', padding: '0.75em 0 0.3em' },
  '.cm-mosu-h5': { fontSize: '1em', padding: '0.7em 0 0.3em' },
  '.cm-mosu-h6': {
    fontSize: '0.94em',
    color: v('fg-muted', '#6e7781'),
    padding: '0.7em 0 0.3em',
  },

  // —— 行内 ——
  '.cm-mosu-strong': { fontWeight: '700' },
  '.cm-mosu-em': { fontStyle: 'italic' },
  '.cm-mosu-strike': { textDecoration: 'line-through', opacity: '0.7' },
  '.cm-mosu-code-inline': {
    fontFamily: v('font-mono', 'ui-monospace, Menlo, Consolas, monospace'),
    fontSize: '0.92em',
    backgroundColor: v('code-bg', '#f0f2f4'),
    borderRadius: '4px',
    padding: '0.1em 0.32em',
  },
  '.cm-mosu-link': { color: v('accent', '#0969da'), textDecoration: 'underline' },

  // —— 行内 HTML ——
  //
  // 这一组只有类名，没有任何 HTML 参与（见 live-preview/inline-html.ts）。
  // 有几个跟 Markdown 自己的写法效果重合（`<b>` ≡ `**`），仍然分开定义 ——
  // 共用类名会让「源码里到底写的哪一种」在样式层面彻底不可分辨。
  '.cm-mosu-html-b, .cm-mosu-html-strong': { fontWeight: '700' },
  '.cm-mosu-html-i, .cm-mosu-html-em': { fontStyle: 'italic' },
  '.cm-mosu-html-u': { textDecoration: 'underline' },
  '.cm-mosu-html-s': { textDecoration: 'line-through', opacity: '0.7' },
  // 上下标用 relative 位移而不是 `vertical-align: super/sub`：
  // 后者会把行高撑开，一行里出现一个 `<sup>` 整段就跳一下
  '.cm-mosu-html-sup, .cm-mosu-html-sub': { fontSize: '0.75em', position: 'relative' },
  '.cm-mosu-html-sup': { top: '-0.4em' },
  '.cm-mosu-html-sub': { bottom: '-0.25em' },
  '.cm-mosu-html-kbd': {
    fontFamily: v('font-mono', 'ui-monospace, Menlo, Consolas, monospace'),
    fontSize: '0.85em',
    padding: '0.1em 0.4em',
    border: `1px solid ${v('border', '#d0d7de')}`,
    borderBottomWidth: '2px',
    borderRadius: '4px',
    backgroundColor: v('code-bg', '#f0f2f4'),
  },
  // `<mark>` 的底色从强调色兑出来，而不是新加一个主题变量：
  // 为一个标签往变量契约里加一条，六个内置主题和所有第三方主题都得跟着改，
  // 代价远大于收益。兑出来的颜色在任何主题下都自动成立。
  '.cm-mosu-html-mark': {
    backgroundColor: `color-mix(in srgb, ${v('accent', '#0969da')} 22%, transparent)`,
    borderRadius: '2px',
  },

  // 显形中的 Markdown 标记：看得见，但不抢戏
  '.cm-mosu-mark': { color: v('marker-fg', '#b0b6bd'), fontWeight: 'normal' },
  '.cm-mosu-list-number': { color: v('marker-fg', '#b0b6bd') },
  '.cm-mosu-bullet': { color: v('marker-fg', '#b0b6bd') },

  // —— 块级 ——
  '.cm-mosu-quote': {
    borderLeft: `3px solid ${v('border', '#d0d7de')}`,
    paddingLeft: '1em',
    color: v('fg-muted', '#6e7781'),
  },
  '.cm-mosu-code-block': {
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
  '.cm-mosu-code-block::-webkit-scrollbar': { height: '6px' },
  '.cm-mosu-code-block::-webkit-scrollbar-thumb': {
    backgroundColor: v('border', '#d0d7de'),
    borderRadius: '3px',
  },
  '.cm-mosu-code-block::-webkit-scrollbar-track': { background: 'transparent' },

  // 围栏被藏起来时，在代码块首行右上角标出语言。
  // 同时补回上下留白 —— 藏围栏用的是「与上一行合并」，会顺带吃掉块前的空行。
  //
  // 块**外**的那 0.9em 是**透明 border**，不是 margin（issue #34，理由见标题
  // 那一段）。这里不能像标题那样直接改成 padding：padding 在背景色**里面**，
  // 底色会跟着长高 0.9em，代码块看起来就浮肿了。透明 border 配
  // `background-clip: padding-box` 之后，底色仍然只铺到 padding 边界，
  // border 那一圈透出页面背景 —— 观感与原来的 margin 一模一样，
  // 而 border 进 `getBoundingClientRect()`，高度表看得见它。
  //
  // 语言选择器的绝对定位不受影响：它的包含块是 padding 盒，
  // 而 padding 盒的位置没动（margin 变 border，元素自身往上长了同样多）。
  '.cm-mosu-code-first': {
    position: 'relative',
    borderTop: '0.9em solid transparent',
    backgroundClip: 'padding-box',
    paddingTop: '0.4em',
  },
  '.cm-mosu-code-block:not(:has(+ .cm-mosu-code-block))': {
    borderBottom: '0.9em solid transparent',
    backgroundClip: 'padding-box',
    paddingBottom: '0.4em',
  },
  // 语言选择器：绝对定位飘在右上角，**不占行内空间**，
  // 否则代码首行会被它顶得往右缩一截
  '.cm-mosu-code-lang': {
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
  '.cm-mosu-code-block:hover .cm-mosu-code-lang, .cm-mosu-code-lang:focus': {
    opacity: '1',
    borderColor: v('border', '#d0d7de'),
  },
  // —— 表格 ——
  //
  // 没有 widget、没有第二状态：表格仍然是文本，只是靠 CSS 摆成表格的样子。
  // `.cm-content` 不是 display:table，但 CSS 2.1 规定非表格父元素下**连续的**
  // table-row 会被自动包进一个匿名表格盒 —— 于是连续的表格行自成一张表，
  // 中间夹一行普通段落就自然断开。详见 live-preview/tables.ts 的说明。
  '.cm-mosu-tr': { display: 'table-row' },
  '.cm-mosu-td': {
    display: 'table-cell',
    padding: '0.28em 0.7em',
    borderBottom: `1px solid ${v('border', '#d0d7de')}`,
    verticalAlign: 'top',
    // 单元格必须能折行（issue #35）。
    //
    // 原先这里是 `white-space: pre`，理由是「一折，列宽就失去参考意义」。
    // 那个取舍在真实长内容面前站不住：`pre` 让每列的**最小内容宽度**等于它
    // 最长那格的整行长度，而匿名表格盒是收缩到适应的 —— 最小宽度大于可用
    // 宽度时，表就一路撑出视口。实测五列长内容的表把滚动区撑宽 7700px，
    // 右侧三列完全看不见，而横向滚动带不回来（滚的是整个编辑区，不是表）。
    // 列宽失真只是不好看，列看不见是功能没了。
    //
    // 不写 `white-space` 就继承 `.cm-content` 的 `pre-wrap` —— **不能**改成
    // `normal`：空白折叠之后 CodeMirror 的坐标映射会跟文档位置对不上。
    //
    // `overflow-wrap: anywhere` 是这条修复的另一半，而且必须是 `anywhere`
    // 不是 `break-word`：只有前者参与**最小内容宽度**的计算。长 URL 和
    // 不带空格的长标识符正是靠它把最小宽度塌下来，表才收得回可用宽度里。
    overflowWrap: 'anywhere',
  },
  '.cm-mosu-tr-head .cm-mosu-td': {
    fontWeight: '600',
    borderBottom: `2px solid ${v('border-strong', '#afb8c1')}`,
  },
  // 分隔行平时是藏起来的（blocks.ts）；光标进表格时露出来，
  // 此刻它也必须是表格行，否则匿名表格盒会被它截成两张，列宽当场分家
  '.cm-mosu-tr-delim .cm-mosu-td': {
    color: v('marker-fg', '#b0b6bd'),
    padding: '0 0.7em',
    borderBottom: 'none',
  },
  '.cm-mosu-td-center': { textAlign: 'center' },
  '.cm-mosu-td-right': { textAlign: 'right' },
  '.cm-mosu-td-left': { textAlign: 'left' },

  // —— YAML front matter ——
  // 弱化成「这是元数据，不是正文」的样子：等宽、小一号、左侧一条边线。
  // 不藏起来 —— 它是内容，用户要能看见和改（跟有序列表编号同一条理由）
  '.cm-mosu-frontmatter': {
    fontFamily: v('font-mono', 'ui-monospace, Menlo, Consolas, monospace'),
    fontSize: '0.85em',
    color: v('fg-muted', '#6e7781'),
    backgroundColor: v('code-bg', '#f0f2f4'),
    borderLeft: `3px solid ${v('border', '#d0d7de')}`,
    paddingLeft: '0.8em',
  },

  // —— 任务列表 ——
  '.cm-mosu-task': {
    verticalAlign: 'middle',
    margin: '0 0.35em 0.15em 0',
    cursor: 'pointer',
  },

  // —— 脚注 ——
  // 引用做成上标；标签本身保持可见 —— 它是内容（「第几条」），不是纯标记
  '.cm-mosu-footnote-ref': {
    verticalAlign: 'super',
    fontSize: '0.78em',
    color: v('accent', '#0969da'),
  },
  '.cm-mosu-footnote-def': {
    fontSize: '0.92em',
    color: v('fg-muted', '#6e7781'),
  },

  '.cm-mosu-hr-line': { display: 'flex', alignItems: 'center', minHeight: '1.7em' },
  '.cm-mosu-hr': {
    display: 'inline-block',
    width: '100%',
    borderTop: `1px solid ${v('border', '#d0d7de')}`,
    verticalAlign: 'middle',
  },

  // 显形中的公式源码：等宽，跟正文区分开
  '.cm-mosu-math-source': {
    fontFamily: v('font-mono', 'ui-monospace, Menlo, Consolas, monospace'),
    fontSize: '0.92em',
    color: v('fg-muted', '#6e7781'),
  },

  // —— 图片 ——
  '.cm-mosu-image img': { maxWidth: '100%', borderRadius: '4px', verticalAlign: 'bottom' },
  '.cm-mosu-image--broken': {
    fontFamily: v('font-mono', 'monospace'),
    fontSize: '0.9em',
    color: v('danger', '#cf222e'),
    textDecoration: 'underline wavy',
  },
  '.cm-mosu-image-source': { color: v('fg-muted', '#6e7781') },

  '.cm-selectionBackground, ::selection': { backgroundColor: v('selection', '#b4d5fe') },
  '.cm-focused .cm-selectionBackground': { backgroundColor: v('selection', '#b4d5fe') },

  // —— 专注模式 ——
  // 用 opacity 而不是把前景色调淡：文档里有代码块底色、表格边框、图片、
  // 公式，逐个调色是永远补不完的清单，而 opacity 一次盖住整层
  '.cm-mosu-dim': {
    opacity: v('focus-dim', '0.35'),
    transition: 'opacity 150ms ease-out',
  },

  // 无障碍：尊重系统的「减少动态效果」设置（docs/design/07 §3）
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-scroller': { scrollBehavior: 'auto' },
    // 变暗的淡入也是动态效果。关掉之后功能不受影响，只是切换得干脆
    '.cm-mosu-dim': { transition: 'none' },
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

export function mosuTheme(): Extension {
  return [baseTheme, mathTheme, mermaidTheme, syntaxHighlighting(markdownHighlight)]
}
