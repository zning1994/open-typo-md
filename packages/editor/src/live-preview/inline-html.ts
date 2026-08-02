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
 * 2. **标签集合是封闭的**（`RENDERABLE_HTML_TAGS`）：只有纯排版语义、不带任何行为的那几个。
 * 3. **带属性的标签一律不认**。`<b>` 渲染，`<b class="x">` 原样显示。
 *    属性是绝大多数注入面的载体（`on*`、`style`、`href`、`src`），
 *    而这几个标签的属性对排版毫无用处 —— 不解析属性，就没有属性可以被利用。
 * 4. **认不出来的一律原样显示**（原则 P2）。`<div>`、`<script>`、`<span style=…>`、
 *    没闭合的 `<b>`，全部按今天的样子显示成字面文本，不藏不猜。
 *
 * 剩下的攻击面是「类名可控吗」—— 不可控，它是 `cm-mosu-html-` 加上一个来自
 * 封闭集合的标签名。
 *
 * ## 块级 HTML（`HTMLBlock`）不在这一档里
 *
 * `<div>…</div>` 那种整块的 HTML 仍然原样显示。块级 HTML 的意义几乎全在
 * 属性和布局上（表格、iframe、带样式的容器），照上面第 3 条根本渲染不出
 * 有价值的东西，而放开属性又正好踩回那条安全路径。
 *
 * ## 白名单本身不在这个文件里
 *
 * 它在 `@mosu/markdown` 的 inline-html.ts —— 因为**导出**那一侧要用同一份。
 * 各写一份的后果就是 issue #1：编辑器里 `H<sub>2</sub>O` 显示成 H₂O，
 * 导出之后变成 H2O，内容的意思变了。
 */
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { INLINE_NODES, parseInlineHtmlTag } from '@mosu/markdown'

export type TagKind = 'open' | 'close' | 'void'

export interface HtmlTag {
  from: number
  to: number
  /** 小写化的标签名。 */
  name: string
  /** 类名后缀，来自 `RENDERABLE_HTML_TAGS`。 */
  cls: string
  kind: TagKind
}

/**
 * 解析单个标签，把结果配上文档位置。
 *
 * 认不出来（有属性、不在白名单、自闭合了一个非空元素）返回 null ——
 * 判定规则在 `@mosu/markdown`，跟导出那一侧共用同一份。
 */
export function parseHtmlTag(source: string, from: number, to: number): HtmlTag | null {
  const tag = parseInlineHtmlTag(source)
  if (!tag) return null
  return { from, to, name: tag.name, cls: tag.as, kind: tag.kind }
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
