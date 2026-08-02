/**
 * 「复制为富文本」用的片段处理（issue #14）。
 *
 * 片段跟文档不一样：文档能带 `<head>`，样式内联进一个 `<style>` 就完事；
 * 片段落在**别人的**文档里（Word、Gmail、飞书），那边不会有我们的 CSS，
 * 而且多数目标会把 `<style>` 元素整个丢掉。所以这里做两件事：
 *
 * 1. 把靠 class 驱动的关键排版摊成 `style` 属性 —— 那是唯一能跨目标活下来的形式；
 * 2. 把 KaTeX 的三份并行表示收敛成一份。
 *
 * ## 第 2 条不是样式问题，是**内容错了**
 *
 * KaTeX 一次输出三样东西：`.katex-mathml` 里的 MathML、MathML 里那份原始
 * TeX（`<annotation>`）、以及 `.katex-html` 里用定位拼出来的视觉版本。
 * 靠 `katex.css` 把前两份藏起来（`.katex-mathml { position:absolute; clip:… }`）
 * 才只看得见一份。没有那份 CSS 时三份**叠在一起**：
 *
 * ```
 * 公式：E=mc2E = mc^2E=mc2 完
 * ```
 *
 * `exportHtmlDocument` 把 `katexCss()` 内联进了外壳，片段这条路没有 ——
 * 于是所有粘出去的公式都是这个样子。
 *
 * 收敛的办法是**只留 MathML**，并把它里面那份 TeX 注解删掉：
 *
 * - 目标支持 MathML（Word、Safari、Firefox、Chrome 109+）→ 公式正常渲染；
 * - 不支持 → 退化成 MathML 里的字符文本 `E=mc2`，**仍然只有一份**。
 *
 * 留 `.katex-html` 是行不通的：它的上下标全靠 `.vlist` 那套绝对定位，
 * 摊成 `style` 属性也复现不出来，没有 CSS 时 `x²` 会变成平铺的 `x2`。
 */
import type { Element, ElementContent, Parent, Root } from 'hast'

function classList(node: Element): string[] {
  const value: unknown = node.properties?.['className']
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(/\s+/)
  return []
}

function isElement(node: { type: string }): node is Element {
  return node.type === 'element'
}

/** 深度优先找第一个满足条件的元素。 */
function find(node: Parent, ok: (el: Element) => boolean): Element | null {
  for (const child of node.children) {
    if (!isElement(child)) continue
    if (ok(child)) return child
    const nested = find(child, ok)
    if (nested) return nested
  }
  return null
}

/** 就地删掉所有满足条件的后代。 */
function prune(node: Parent, drop: (el: Element) => boolean): void {
  node.children = node.children.filter((child) => !(isElement(child) && drop(child)))
  for (const child of node.children) {
    if (isElement(child)) prune(child, drop)
  }
}

/** 把每个 `.katex` 收敛成单独一个 `<math>`。 */
export function collapseKatex(tree: Root): void {
  const walk = (node: Parent): void => {
    node.children = node.children.map((child) => {
      if (!isElement(child)) return child
      if (!classList(child).includes('katex')) {
        walk(child)
        return child
      }

      const math = find(child, (el) => el.tagName === 'math')
      // 找不到 MathML（KaTeX 换了输出形态）就原样留着 ——
      // 三份重叠虽然难看，也好过把公式整个弄丢（原则 P2）
      if (!math) return child

      // `<annotation>` 是给机器读的 TeX 源码。MathML 渲染时它不显示，
      // 但**目标不支持 MathML 时它会作为文本露出来** —— 那就又变成两份了
      prune(math, (el) => el.tagName === 'annotation')
      return math as ElementContent
    })
  }
  walk(tree)
}

/**
 * 摊成行内样式的规则。
 *
 * 全部写死成浅色的字面值，不用 CSS 变量 —— 目标文档里没有我们的 `:root`，
 * `var()` 会整条失效（连 fallback 都不一定生效，Word 的解析器很挑）。
 *
 * 只覆盖「没有它就看不出这是什么」的那几样。字号、行距、正文颜色刻意不碰：
 * 粘贴的内容应该融进目标文档的排版，而不是把我们这边的观感硬塞过去。
 */
const RULES: readonly { match: (el: Element) => boolean; style: string }[] = [
  {
    match: (el) => el.tagName === 'pre',
    style:
      'background:#f0f2f4;padding:0.8em 1em;border-radius:6px;overflow-x:auto;' +
      'font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap',
  },
  {
    // 代码块里的 code 不要再套一层底色，否则是双层灰
    match: (el) => el.tagName === 'code',
    style: 'font-family:ui-monospace,Menlo,Consolas,monospace',
  },
  {
    match: (el) => el.tagName === 'blockquote',
    style: 'margin:1em 0;padding-left:1em;border-left:3px solid #d0d7de;color:#6e7781',
  },
  { match: (el) => el.tagName === 'table', style: 'border-collapse:collapse' },
  {
    match: (el) => el.tagName === 'th' || el.tagName === 'td',
    style: 'border:1px solid #d0d7de;padding:0.35em 0.7em',
  },
  { match: (el) => el.tagName === 'hr', style: 'border:0;border-top:1px solid #d0d7de' },
  {
    match: (el) => el.tagName === 'kbd',
    style: 'border:1px solid #d0d7de;border-radius:4px;padding:0.1em 0.35em;font-size:0.9em',
  },
  { match: (el) => el.tagName === 'mark', style: 'background:#fff3a3' },
  { match: (el) => el.tagName === 'img', style: 'max-width:100%;height:auto' },
]

/** 行内代码要底色，块内代码不要 —— 靠父节点区分，所以单独走一趟。 */
const INLINE_CODE_STYLE = 'background:#f0f2f4;padding:0.1em 0.32em;border-radius:4px'

function addStyle(el: Element, declarations: string): void {
  const existing = el.properties?.['style']
  const prefix = typeof existing === 'string' && existing !== '' ? `${existing};` : ''
  el.properties = { ...el.properties, style: prefix + declarations }
}

/** 把关键排版摊成 `style` 属性。 */
export function inlineFragmentStyles(tree: Root): void {
  const walk = (node: Parent, inPre: boolean): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue
      for (const rule of RULES) {
        if (rule.match(child)) addStyle(child, rule.style)
      }
      if (child.tagName === 'code' && !inPre) addStyle(child, INLINE_CODE_STYLE)
      walk(child, inPre || child.tagName === 'pre')
    }
  }
  walk(tree, false)
}
