/**
 * 数学公式语法扩展：行内 `$…$` 与块级 `$$…$$`。
 *
 * 跟脚注一样，`@lezer/markdown` 不提供，自己写。渲染（KaTeX）是编辑器的事，
 * 这里只负责解析出节点 —— 三件套契约的第一件（docs/design/03 §2）。
 *
 * ## 行内公式最难的地方是「别把钱当公式」
 *
 * `$` 在自然语言里首先是货币符号。`我花了 $5 买了 $10 的东西` 里有两个 `$`，
 * 天真的实现会把 `5 买了 ` 渲染成公式。所以定界符要满足一组约束
 * （沿用 pandoc / remark-math 的成熟规则，不自创）：
 *
 * - 开定界符右边**不能紧跟空白**（`$ x$` 不是公式）；
 * - 闭定界符左边**不能紧跟空白**（`$x $` 不是公式）；
 * - 闭定界符右边**不能紧跟数字**（`$5 和 $10` 因此不成立）；
 * - 中间不能跨空行（公式不会横跨段落）。
 *
 * 满足不了就当普通文本，一个字符都不动（原则 P2）。
 */
import { tags } from '@lezer/highlight'
import type { BlockContext, InlineContext, Line, MarkdownConfig } from '@lezer/markdown'

export const MATH_NODES = {
  inline: 'InlineMath',
  /** 写在一行里的 `$$…$$`。语义上是行间公式，但它在**行内**位置出现。 */
  display: 'DisplayMath',
  /** 独占若干行的 `$$` … `$$`。 */
  block: 'BlockMath',
  mark: 'MathMark',
  content: 'MathContent',
} as const

const DOLLAR = 36 // $
const BLOCK_FENCE = /^\s*\$\$\s*$/

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === -1
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/**
 * 一行之内的 `$$…$$`。
 *
 * 定界符规则比行内 `$…$` 宽松：`$$ x $$` 是常见写法，而 `$$` 本身已经足够
 * 不像货币符号了，不需要那套防误伤的约束。
 */
function parseDisplay(cx: InlineContext, pos: number): number {
  for (let at = pos + 2; at < cx.end - 1; at++) {
    const ch = cx.char(at)
    if (ch === 10) return -1 // 不跨行，跨行的交给块级规则
    if (ch === 92) {
      at++
      continue
    }
    if (ch !== DOLLAR || cx.char(at + 1) !== DOLLAR) continue
    if (at === pos + 2) return -1 // `$$$$` 空公式
    return cx.addElement(
      cx.elt(MATH_NODES.display, pos, at + 2, [
        cx.elt(MATH_NODES.mark, pos, pos + 2),
        cx.elt(MATH_NODES.content, pos + 2, at),
        cx.elt(MATH_NODES.mark, at, at + 2),
      ]),
    )
  }
  return -1
}

export const mathExtension: MarkdownConfig = {
  defineNodes: [
    { name: MATH_NODES.inline, style: tags.special(tags.content) },
    { name: MATH_NODES.display, style: tags.special(tags.content) },
    { name: MATH_NODES.block, block: true },
    { name: MATH_NODES.mark, style: tags.processingInstruction },
    { name: MATH_NODES.content },
  ],

  parseInline: [
    {
      name: MATH_NODES.inline,
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== DOLLAR) return -1

        // 写在一行里的 `$$…$$`：语义上是行间公式，但它出现在行内位置，
        // 块级规则（要求 `$$` 独占一行）够不着它。不处理的话，
        // 行内规则会从第二个 `$` 起手，把它啃成 `$ 公式 $` 外加两个孤零零的 `$`
        if (cx.char(pos + 1) === DOLLAR) return parseDisplay(cx, pos)
        // 开定界符右边不能是空白，否则 `成本 $ 100` 会被当成公式起点
        if (isSpace(cx.char(pos + 1))) return -1

        let end = -1
        for (let at = pos + 1; at < cx.end; at++) {
          const ch = cx.char(at)
          // 公式不跨行
          if (ch === 10) return -1
          if (ch === 92) {
            at++ // 反斜杠转义：`\$` 不是定界符
            continue
          }
          if (ch !== DOLLAR) continue
          // 闭定界符左边不能是空白
          if (isSpace(cx.char(at - 1))) continue
          // 闭定界符右边不能是数字 —— 这一条挡掉的正是 `$5 和 $10`
          if (isDigit(cx.char(at + 1))) return -1
          end = at
          break
        }
        if (end < 0 || end === pos + 1) return -1 // 找不到收尾、或者是个空公式

        return cx.addElement(
          cx.elt(MATH_NODES.inline, pos, end + 1, [
            cx.elt(MATH_NODES.mark, pos, pos + 1),
            cx.elt(MATH_NODES.content, pos + 1, end),
            cx.elt(MATH_NODES.mark, end, end + 1),
          ]),
        )
      },
      // 抢在行内代码之前会破坏 `` `$x$` `` 的字面量语义，所以排在它后面
      after: 'InlineCode',
    },
  ],

  parseBlock: [
    {
      name: MATH_NODES.block,
      parse(cx: BlockContext, line: Line): boolean {
        if (!BLOCK_FENCE.test(line.text)) return false

        const from = cx.lineStart + line.pos
        const openTo = cx.lineStart + line.text.length
        const contentFrom = openTo + 1

        // 初值是**开围栏的结尾**而不是内容起点：文档就此结束（`$$` 是最后一行）
        // 时，内容起点已经越过了文档末尾，拿它当块的终点会造出一个
        // 超出文档长度的节点，下游 `doc.lineAt()` 直接抛错
        let contentTo = openTo
        let closeFrom = -1
        let closeTo = -1

        while (cx.nextLine()) {
          if (BLOCK_FENCE.test(line.text)) {
            closeFrom = cx.lineStart
            closeTo = cx.lineStart + line.text.length
            cx.nextLine()
            break
          }
          contentTo = cx.lineStart + line.text.length
        }

        // 没闭合也照样成块（跟围栏代码块一致的取舍）：`$$` 是用户明确打出来的
        // 起始标记，此后的内容本来就该按公式对待，直到他把它关上
        const children = [cx.elt(MATH_NODES.mark, from, openTo)]
        if (contentTo > contentFrom) {
          children.push(cx.elt(MATH_NODES.content, contentFrom, contentTo))
        }
        if (closeFrom >= 0) children.push(cx.elt(MATH_NODES.mark, closeFrom, closeTo))

        cx.addElement(
          cx.elt(MATH_NODES.block, from, closeFrom >= 0 ? closeTo : contentTo, children),
        )
        return true
      },
      before: 'HorizontalRule',
    },
  ],
}
