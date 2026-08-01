/**
 * YAML front matter 扩展。
 *
 * ## 为什么不用上游现成的 `yamlFrontmatter`
 *
 * `@codemirror/lang-yaml` 提供了 `yamlFrontmatter({content})`，一行就能接上。
 * 但它有个在编辑器里非常难受的性质：**开围栏没闭合时，它把文档剩下的全部内容
 * 都当成 YAML**。
 *
 * 而「没闭合」正是用户敲下 `---` 之后、写完元数据之前的**每一秒**。
 * 表现就是：光标还在第二行，下面整篇文章的标题、列表、代码块渲染集体塌掉，
 * 变成一片 YAML 注释色；等收尾的 `---` 打完才恢复。
 *
 * 严格说没有吞内容（字符一个不少，位置也对），但呈现层塌成那样，
 * 跟坏了没有区别。
 *
 * 所以这里自己写：**必须闭合才算 front matter**，没闭合就当普通 Markdown。
 * 顺带还有两个好处 ——
 *
 * - 顶层语言仍然是 Markdown，语法树不多两级包装，
 *   所有既有的装饰规则、命令、`isActiveAt` 判定一律不受影响；
 * - YAML 高亮靠 `parseMixed` 嵌进来，一点没丢。
 */
import { parseMixed } from '@lezer/common'
import { yamlLanguage } from '@codemirror/lang-yaml'
import { tags } from '@lezer/highlight'
import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown'

export const FRONTMATTER_NODES = {
  block: 'Frontmatter',
  /** 开闭两条 `---`。 */
  mark: 'FrontmatterMark',
  /** 中间那段 YAML，交给 YAML 解析器。 */
  content: 'FrontmatterContent',
} as const

/** 围栏行：三个或更多的 `-`，行内不能有别的东西。 */
const FENCE = /^-{3,}\s*$/

export const frontmatterExtension: MarkdownConfig = {
  defineNodes: [
    { name: FRONTMATTER_NODES.block, block: true },
    { name: FRONTMATTER_NODES.mark, style: tags.processingInstruction },
    { name: FRONTMATTER_NODES.content },
  ],

  parseBlock: [
    {
      name: FRONTMATTER_NODES.block,
      parse(cx: BlockContext, line: Line): boolean {
        // 只认文档最开头。别处的 `---` 是分隔线，不是元数据
        if (cx.lineStart !== 0 || line.pos !== 0) return false
        if (!FENCE.test(line.text)) return false

        // 下一行是空的（或者文档到此为止）→ 这压根不是 front matter，
        // 而是一条以分隔线开头的文档。**必须在消耗任何行之前判掉** ——
        // Lezer 的块解析器一旦 `nextLine()` 就没有回退可言，
        // 返回 false 也换不回已经吃掉的行。
        if (cx.peekLine().trim() === '') return false

        const openTo = line.text.length
        const contentFrom = openTo + 1

        let closeFrom = -1
        let closeTo = -1
        let contentTo = contentFrom

        while (cx.nextLine()) {
          if (FENCE.test(line.text)) {
            closeFrom = cx.lineStart
            closeTo = cx.lineStart + line.text.length
            cx.nextLine() // 越过收尾围栏
            break
          }
          // 空行即边界。
          //
          // 这一条是在「Lezer 不给任意前瞻」这个约束下能做到的最好结果。
          // 理想行为是「没闭合就整块退化」，但那需要先扫完再决定，
          // 而扫的过程本身就把行吃掉了。
          //
          // 退而求其次：YAML front matter 在真实文档里从不含空行，
          // 而正文与元数据之间**一定**隔着一个空行。以空行为界，
          // 用户正在输入、还没打出收尾 `---` 时，塌掉的最多是这一段，
          // 而不是整篇文章 —— 后者正是上游 `yamlFrontmatter` 的行为。
          if (line.text.trim() === '') break
          contentTo = cx.lineStart + line.text.length
        }

        const children = [cx.elt(FRONTMATTER_NODES.mark, 0, openTo)]
        // 内容为空时不建节点：零长度区间对混合解析器不友好
        if (contentTo > contentFrom) {
          children.push(cx.elt(FRONTMATTER_NODES.content, contentFrom, contentTo))
        }
        if (closeFrom >= 0) children.push(cx.elt(FRONTMATTER_NODES.mark, closeFrom, closeTo))

        cx.addElement(
          cx.elt(FRONTMATTER_NODES.block, 0, closeFrom >= 0 ? closeTo : contentTo, children),
        )
        return true
      },
      // 必须抢在分隔线前面：否则开头那行 `---` 先被当成 HorizontalRule
      before: 'HorizontalRule',
    },
  ],

  // 内容交给 YAML 解析器，高亮一点不丢
  wrap: parseMixed((node) =>
    node.name === FRONTMATTER_NODES.content ? { parser: yamlLanguage.parser } : null,
  ),
}
