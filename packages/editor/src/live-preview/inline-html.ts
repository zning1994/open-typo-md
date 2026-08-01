/**
 * 行内 HTML 的渲染（docs/design/02 §5.4、路线图 M4.5 #6）。
 *
 * ## 这件事为什么一直搁置着
 *
 * 「渲染文档里的 HTML」听起来是个显示功能，实际上是这套东西里**唯一一条
 * 安全相关的路径**：渲染进程手里握着 `fs.write` 与 `shell.openExternal`，
 * 用户文档里的 `<img onerror>` 一旦真的进了 DOM，XSS 当场升级成 RCE。
 * 通用做法是「解析 + 消毒 + 白名单」，而消毒器漏一个就是全盘皆输。
 *
 * ## 所以这里根本不做那件事
 *
 * 换一个**结构上就不可能出问题**的做法：
 *
 * 1. **一个字节的 HTML 都不进 DOM。** 没有 `innerHTML`，没有 `insertAdjacentHTML`，
 *    没有 `DOMParser`。渲染效果全部由 CodeMirror 的 mark 装饰 + CSS 类名达成 ——
 *    也就是说，我们从头到尾只往 DOM 里写**类名**，那是个封闭集合。
 * 2. **标签集合是封闭的**，见 `RENDERABLE`：只有纯排版语义、不带任何行为的那几个。
 * 3. **带属性的标签一律不认**。`<b>` 渲染，`<b class="x">` 原样显示。
 *    属性是绝大多数注入面的载体（`on*`、`style`、`href`、`src`），
 *    而这几个标签的属性对排版毫无用处 —— 不解析属性，就没有属性可以被利用。
 * 4. **认不出来的一律原样显示**（原则 P2）。`<div>`、`<script>`、`<span style=…>`、
 *    没闭合的 `<b>`，全部按今天的样子显示成字面文本，不藏不猜。
 *
 * 剩下的攻击面是「类名可控吗」—— 不可控，它是 `cm-typo-html-` 加上一个来自
 * 封闭集合的标签名。
 *
 * ## 块级 HTML（`HTMLBlock`）不在这一档里
 *
 * `<div>…</div>` 那种整块的 HTML 仍然原样显示。块级 HTML 的意义几乎全在
 * 属性和布局上（表格、iframe、带样式的容器），照上面第 3 条根本渲染不出
 * 有价值的东西，而放开属性又正好踩回那条安全路径。
 */
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { INLINE_NODES } from '@typo/markdown'

/**
 * 会被渲染的标签，以及它们对应的类名后缀。
 *
 * 入选标准只有一条：**纯排版语义、没有行为、不需要属性也有意义**。
 * 按这条标准落选的例子：`<a>`（离了 href 没意义）、`<img>`（同上）、
 * `<span>`（离了 class/style 没意义）、`<code>`（Markdown 有 `` ` ``，
 * 两套写法渲染成同一个样子只会让人分不清源码里到底是哪个）。
 */
const RENDERABLE = new Map<string, string>([
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
const VOID_TAGS = new Set(['br'])

/**
 * 标签的字面写法。
 *
 * 刻意**不允许属性**，也不允许标签名与 `>` 之间出现除了自闭合斜杠以外的东西 ——
 * 正则从 `^` 锚到 `$`，`<b class="x">` 直接匹配失败，于是走「认不出来」那条路。
 */
const TAG = /^<(\/?)([a-zA-Z][a-zA-Z\d]*)\s*(\/?)>$/

export type TagKind = 'open' | 'close' | 'void'

export interface HtmlTag {
  from: number
  to: number
  /** 小写化的标签名。 */
  name: string
  /** 类名后缀，来自 `RENDERABLE`。 */
  cls: string
  kind: TagKind
}

/**
 * 解析单个标签。认不出来（有属性、不在白名单、自闭合了一个非空元素）返回 null。
 */
export function parseHtmlTag(source: string, from: number, to: number): HtmlTag | null {
  const match = TAG.exec(source)
  if (!match) return null

  const closing = match[1] === '/'
  const name = (match[2] ?? '').toLowerCase()
  const selfClosing = match[3] === '/'

  const cls = RENDERABLE.get(name)
  const isVoid = VOID_TAGS.has(name)
  if (cls === undefined && !isVoid) return null

  if (isVoid) {
    // `</br>` 不是合法写法，不认
    if (closing) return null
    return { from, to, name, cls: name, kind: 'void' }
  }
  // `<b/>` 这种把非空元素自闭合的写法，浏览器的处理各不相同，我们不猜
  if (selfClosing) return null

  return { from, to, name, cls: cls as string, kind: closing ? 'close' : 'open' }
}

export interface HtmlPair {
  open: HtmlTag
  close: HtmlTag
}

export interface HtmlLayout {
  /** 配上对的成对标签，文档序。 */
  pairs: HtmlPair[]
  /** 空元素。 */
  voids: HtmlTag[]
}

/**
 * 扫一个容器节点里的行内 HTML，把标签配成对。
 *
 * **按容器扫而不是按可见区扫**：`<b>` 与 `</b>` 完全可能一个在视口上边、
 * 一个在下边，只看可见区的话会把一个孤零零的 `<b>` 当成没闭合。
 * 容器（段落 / 标题 / 单元格）本身是有界的，扫它一遍的代价跟里面的标签数成正比。
 *
 * 配对用栈，跟浏览器一样「就近配对」，但有两处刻意的保守：
 *
 * - **认不出来的标签直接跳过**，不入栈也不消栈。于是 `<b>x<span y>z</span></b>`
 *   里的 `<b>` 照样配得上对，而 `<span>` 自始至终按字面显示；
 * - **配不上对的开标签被丢弃**（`stack.length = i`），不往外找。
 *   `<b><i>x</b>` 里的 `<i>` 就此作废，只有 `<b>` 成对 —— 交叉嵌套是坏写法，
 *   与其猜用户想要什么，不如只渲染确定的那部分。
 */
export function htmlLayoutOf(state: EditorState, container: SyntaxNode): HtmlLayout {
  const pairs: HtmlPair[] = []
  const voids: HtmlTag[] = []
  const stack: HtmlTag[] = []

  for (const node of container.getChildren(INLINE_NODES.htmlTag)) {
    const tag = parseHtmlTag(state.doc.sliceString(node.from, node.to), node.from, node.to)
    if (!tag) continue

    if (tag.kind === 'void') {
      voids.push(tag)
    } else if (tag.kind === 'open') {
      stack.push(tag)
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        const open = stack[i]
        if (open && open.name === tag.name) {
          pairs.push({ open, close: tag })
          stack.length = i
          break
        }
      }
    }
  }

  pairs.sort((a, b) => a.open.from - b.open.from)
  return { pairs, voids }
}
