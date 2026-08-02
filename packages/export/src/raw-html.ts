/**
 * 原始 HTML 在导出产物里的去向（issue #1）。
 *
 * ## 之前这里什么都没有，于是内容被静默吃掉
 *
 * `remarkRehype({ allowDangerousHtml: true })` 把文档里的原始 HTML 变成 hast 的
 * `raw` 节点，而 `rehypeStringify` 在 `allowDangerousHtml: false` 下**直接丢弃**
 * 这类节点 —— 管线里没有任何一步把它们变成真元素或真文本。结果是：
 *
 * - `H<sub>2</sub>O` 导出成 `H2O`。这不是掉了样式，是**内容的意思变了**；
 * - `<div>block</div>` 导出成 `block`，`<script>alert(1)</script>` 导出成
 *   `alert(1)` —— 用户在编辑器里明明看得见的字面文本，产物里整段不见了。
 *
 * 两条都违反 06 §4 的「绝不静默丢内容」和 README 的「写下的就是看到的」。
 *
 * ## 规则跟编辑器是同一份
 *
 * 白名单在 `@mosu/markdown`（`parseInlineHtmlTag`），编辑器和这里共用。
 * 于是屏幕上渲染成上标的，产物里就是 `<sup>`；屏幕上按字面显示的，
 * 产物里就是转义后的可见文本。**两边不可能再分家** —— 分家过一次，
 * 代价就是这个 issue。
 *
 * ## 认不出来的为什么必须转义而不是删掉
 *
 * 删掉的话，一篇讨论 HTML 本身的技术文章，导出后所有代码示例凭空消失，
 * 而且没有任何痕迹告诉读者这里少了东西。转义成文本则是**无损**的：
 * 浏览器里显示的就是用户当初写下的那串字符。
 *
 * 转义本身不需要我们动手 —— 变成 hast 的 `text` 节点之后，
 * `rehypeStringify` 按定义会把 `<` `&` 转义掉。我们只负责**改变节点类型**。
 */
import type { Element, ElementContent, Parent, Root, RootContent, Text } from 'hast'
import { parseInlineHtmlTag, type InlineHtmlTag } from '@mosu/markdown'

/** hast 的 `raw` 节点（`allowDangerousHtml` 打开时才会出现，类型没进 hast 主定义）。 */
interface RawNode {
  type: 'raw'
  value: string
}

function isRaw(node: { type: string }): node is RawNode {
  return node.type === 'raw'
}

function text(value: string): Text {
  return { type: 'text', value }
}

/** 待配对的开标签，以及它在当前 children 数组里的下标。 */
interface Pending {
  tag: InlineHtmlTag
  index: number
}

/**
 * 把一层 children 里的 `raw` 节点就地处理掉。
 *
 * 配对算法跟编辑器那侧刻意一致（live-preview/inline-html.ts 的 `htmlLayoutOf`）：
 * 用栈就近配对，认不出来的标签既不入栈也不消栈，配不上对的开标签作废。
 * 一致不是为了省事，是因为**两边给出不同答案时用户看到的就是「导出改了我的文档」**。
 *
 * 从后往前配：先找到闭标签，再往回找最近的同名开标签，把中间的兄弟节点
 * 整体搬进新元素。这样下标不会因为前面的改动而失效。
 */
function convert(children: (ElementContent | RootContent)[]): (ElementContent | RootContent)[] {
  const out: (ElementContent | RootContent)[] = []
  const open: Pending[] = []

  for (const child of children) {
    if (!isRaw(child)) {
      out.push(child)
      continue
    }

    const tag = parseInlineHtmlTag(child.value)
    if (!tag) {
      // 认不出来：整段按字面文本输出（原则 P2）
      out.push(text(child.value))
      continue
    }

    if (tag.kind === 'void') {
      out.push({ type: 'element', tagName: tag.as, properties: {}, children: [] })
      continue
    }

    if (tag.kind === 'open') {
      // 先按字面塞进去占位。配上对了会被换成真元素；配不上对就**原样留着**，
      // 于是一个没闭合的 `<b>` 在产物里仍然看得见 —— 跟编辑器里一样
      open.push({ tag, index: out.length })
      out.push(text(child.value))
      continue
    }

    // 闭标签：往回找最近的同名开标签
    let matched = -1
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i]?.tag.name === tag.name) {
        matched = i
        break
      }
    }
    if (matched === -1) {
      // 配不上对的闭标签同样按字面显示，不静默丢弃
      out.push(text(child.value))
      continue
    }

    const pending = open[matched] as Pending
    // 交叉嵌套（`<b><i>x</b>`）里被跨过的开标签就此作废，它们留下的
    // 字面文本已经在 out 里了，正好就是「原样显示」
    open.length = matched

    const inner = out.splice(pending.index) as ElementContent[]
    inner.shift() // 丢掉开标签的字面占位
    out.push({
      type: 'element',
      tagName: pending.tag.as,
      properties: {},
      children: inner,
    })
  }

  return out
}

/**
 * 递归处理整棵树。
 *
 * 不用 `unist-util-visit`：它在遍历途中改 children 数组是未定义行为，
 * 而这里做的正是「把一段兄弟节点换成一个元素」。自己走一遍，代价一样。
 */
export function materializeRawHtml(tree: Root): void {
  const walk = (node: Parent): void => {
    for (const child of node.children) {
      if ('children' in child && Array.isArray((child as Parent).children)) {
        walk(child as Parent)
      }
    }
    node.children = convert(node.children) as Parent['children']
  }
  walk(tree)
}

/**
 * 块级 `raw` 会连着换行一起进来（`<div>\nx\n</div>` 是一个节点）。
 * 变成文本之后它在 `<body>` 底下裸着，语义上不属于任何段落 ——
 * 包一层 `<p>` 让它跟编辑器里「一个块」的观感对齐。
 */
export function wrapLooseText(tree: Root): void {
  tree.children = tree.children.map((child) =>
    child.type === 'text' && child.value.trim() !== ''
      ? ({
          type: 'element',
          tagName: 'p',
          properties: { className: ['mosu-raw-html'] },
          children: [child],
        } as Element)
      : child,
  )
}
