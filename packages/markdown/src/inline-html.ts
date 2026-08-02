/**
 * 行内 HTML 的**标签白名单**（docs/design/02 §5.4、06 §2）。
 *
 * 这份表放在最底层，是因为它有**两个**消费方，而它们必须给出一致的答案：
 *
 * - 编辑器（`@mosu/editor` 的 live-preview/inline-html.ts）据此决定屏幕上
 *   把哪些标签渲染成排版效果、哪些原样显示；
 * - 导出（`@mosu/export` 的 html.ts）据此决定产物里把哪些标签变成真元素、
 *   哪些转义成可见文本。
 *
 * 两边各写一份的后果就是 issue #1：编辑器里 `H<sub>2</sub>O` 显示成 H₂O，
 * 导出之后变成 `H2O` —— **内容的意思变了**，而不只是样式没了。
 * 「写下的就是看到的」这条承诺，只有当这份表是同一份时才成立。
 *
 * ## 入选标准只有一条
 *
 * **纯排版语义、没有行为、不需要属性也有意义。**
 * 按这条标准落选的例子：`<a>`（离了 href 没意义）、`<img>`（同上）、
 * `<span>`（离了 class/style 没意义）、`<code>`（Markdown 有反引号，
 * 两套写法渲染成同一个样子只会让人分不清源码里到底是哪个）。
 *
 * ## 不解析属性，就没有属性可以被利用
 *
 * `TAG` 从 `^` 锚到 `$`，标签名和 `>` 之间除了自闭合斜杠什么都不许有。
 * `<b class="x">` 直接匹配失败，走「认不出来」那条路原样显示。
 * 属性是绝大多数注入面的载体（`on*`、`style`、`href`、`src`），
 * 而这几个标签的属性对排版毫无用处。
 */

/**
 * 会被渲染的标签 → 它的呈现标签。
 *
 * 值不总等于键：`<del>` 和 `<s>` 是一回事，`<ins>` 和 `<u>` 是一回事。
 * 编辑器拿它当类名后缀（`cm-mosu-html-s`），导出拿它当元素名。
 */
export const RENDERABLE_HTML_TAGS: ReadonlyMap<string, string> = new Map([
  ['b', 'b'],
  ['strong', 'strong'],
  ['i', 'i'],
  ['em', 'em'],
  ['u', 'u'],
  ['s', 's'],
  ['del', 's'],
  ['ins', 'u'],
  ['sub', 'sub'],
  ['sup', 'sup'],
  ['kbd', 'kbd'],
  ['mark', 'mark'],
])

/** 空元素：没有闭合标签，自己就是全部。目前只有 `<br>`。 */
export const VOID_HTML_TAGS: ReadonlySet<string> = new Set(['br'])

/**
 * 标签的字面写法。
 *
 * 见文件头：不允许属性，也不允许标签名与 `>` 之间出现除了自闭合斜杠以外的东西。
 */
const TAG = /^<(\/?)([a-zA-Z][a-zA-Z\d]*)\s*(\/?)>$/

export type InlineHtmlTagKind = 'open' | 'close' | 'void'

export interface InlineHtmlTag {
  /** 小写化的标签名，例如 `del`。 */
  name: string
  /** 呈现用的标签名，来自 `RENDERABLE_HTML_TAGS`，例如 `del` → `s`。 */
  as: string
  kind: InlineHtmlTagKind
}

/**
 * 解析单个标签的字面写法。
 *
 * 认不出来（有属性、不在白名单、把非空元素自闭合了）一律返回 null ——
 * 调用方据此走「原样显示」那条路（原则 P2）。
 */
export function parseInlineHtmlTag(source: string): InlineHtmlTag | null {
  const match = TAG.exec(source)
  if (!match) return null

  const closing = match[1] === '/'
  const name = (match[2] ?? '').toLowerCase()
  const selfClosing = match[3] === '/'

  if (VOID_HTML_TAGS.has(name)) {
    // `</br>` 不是合法写法，不认
    if (closing) return null
    return { name, as: name, kind: 'void' }
  }

  const as = RENDERABLE_HTML_TAGS.get(name)
  if (as === undefined) return null
  // `<b/>` 这种把非空元素自闭合的写法，浏览器的处理各不相同，我们不猜
  if (selfClosing) return null

  return { name, as, kind: closing ? 'close' : 'open' }
}
