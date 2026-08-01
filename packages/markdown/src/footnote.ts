/**
 * 脚注语法扩展。
 *
 * `@lezer/markdown` 的 GFM 包**不含脚注** —— 它只有表格、任务列表、删除线、
 * 自动链接四样。而 GitHub 自己是支持脚注的，路线图也把它排进了 M2，
 * 所以这一份得自己写。
 *
 * 它同时是 docs/design/03 §2「三件套契约」里 Lezer 那一件的第一个实例：
 * 内置功能也走插件 API 的同一条路，不开后门。语义侧（mdast 桥接）与
 * 序列化留到导出管线（M4）时补，那时才有第二个消费者。
 *
 * 语法：
 *
 * ```markdown
 * 正文里引用一下[^注1]。
 *
 * [^注1]: 这是脚注的内容，可以有*行内格式*。
 * ```
 *
 * **已知限制（有意为之）**：
 *
 * - 标签里不允许空白和 `]`。GitHub 实际上更宽松，但放开之后
 *   `[^ ]`、`[^a] b]` 这类写法的归属会变得难以预测，而它们在真实文档里
 *   几乎不出现。匹配不上就退化成普通文本，不吞内容（原则 P2）。
 * - 定义只吃到空行为止，**不支持跨空行的多段落脚注**（GitHub 靠 4 空格
 *   缩进续写）。用叶子块（leaf block）实现换来的是惰性延续与「下一条定义
 *   自动断开」两件事白送，而多段落脚注在写作场景里极罕见。
 *   真要支持得改成 composite block，成本不划算。
 */
import type {
  BlockContext,
  Element,
  InlineContext,
  LeafBlock,
  MarkdownConfig,
} from '@lezer/markdown'
import { tags } from '@lezer/highlight'

/** 脚注节点名。跟 nodes.ts 里的常量保持一致，改名时两处一起改。 */
export const FOOTNOTE_NODES = {
  /** 正文里的引用：`[^1]` */
  ref: 'FootnoteRef',
  /** 定义块整体：`[^1]: 内容` */
  definition: 'Footnote',
  /** 标签文本（不含方括号与 `^`） */
  label: 'FootnoteLabel',
  /** `[^`、`]`、`]:` 这些纯标记 */
  mark: 'FootnoteMark',
} as const

const BRACKET_OPEN = 91 // [
const CARET = 94 // ^
const BRACKET_CLOSE = 93 // ]

/** 定义行：行首（已跳过容器标记）的 `[^标签]:`。 */
const DEFINITION = /^\[\^([^\]\s]+)\]:/

/**
 * 扫描 `[^标签]`，返回闭合方括号之后的位置；不是合法脚注引用则返回 -1。
 *
 * 标签必须非空且不含空白 —— 见文件头的限制说明。
 */
function scanRef(read: (pos: number) => number, start: number, end: number): number {
  if (read(start) !== BRACKET_OPEN || read(start + 1) !== CARET) return -1
  let pos = start + 2
  while (pos < end) {
    const ch = read(pos)
    if (ch === BRACKET_CLOSE) {
      // `[^]` 这种空标签不算
      return pos === start + 2 ? -1 : pos + 1
    }
    // 空白、换行、嵌套的 `[` 都判定为「这不是脚注」
    if (ch < 33 || ch === BRACKET_OPEN) return -1
    pos++
  }
  return -1
}

/**
 * 定义块的叶子解析器。
 *
 * 用叶子块而不是「急切块解析器」（eager `parse`）是权衡后的选择：叶子块能白拿
 * 上游的惰性延续、容器标记（引用块前缀）对齐、以及被其他块结构打断这三件事。
 * 自己写急切解析器就得把这三样重新实现一遍，而其中「跨行时保持字符偏移正确」
 * 一项在引用块里格外容易错。
 */
class FootnoteDefinitionParser {
  /**
   * 恒返回 false —— 后续行交给默认的段落累积逻辑，惰性延续自然生效。
   *
   * 但在返回之前必须先把排在后面的解析器摘掉，原因是个实测出来的坑：
   *
   * `[^1]: 内容` 完全符合**链接引用定义**的形状（标签 `[^1]`、目标 `内容`），
   * 上游的 LinkReference 叶子解析器同样会盯上这一块。单行定义时没事 ——
   * `finishLeaf` 按 `leaf.parsers` 顺序取第一个成功的，我们靠
   * `before: 'LinkReference'` 排在前面。**但只要定义换行续写**，
   * LinkReference 会在第二行的 `nextLine` 里直接把块结掉，
   * 根本走不到 `finish` 阶段，脚注就被吃成了链接引用。
   *
   * `nextLine` 是唯一能抢在它之前插手的位置（上游按数组顺序依次调用，
   * 我们排第一），所以在这里截断数组。`for...of` 每步都重新比对 length，
   * 截断后循环立刻停止，不会漏调也不会越界。
   *
   * 代价讲清楚：一个 `[^x]:` 开头的块不能再被解析成 Setext 标题或表格
   * （二者都排在 LinkReference 之后）。「拿 `===` 给脚注定义加下划线」
   * 这种写法不存在于真实文档，接受。
   */
  nextLine(_cx: BlockContext, _line: unknown, leaf: LeafBlock): boolean {
    const self = leaf.parsers.indexOf(this)
    if (self >= 0) leaf.parsers.length = self + 1
    return false
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    const match = DEFINITION.exec(leaf.content)
    if (!match) return false

    const label = match[1] as string
    const start = leaf.start
    const labelFrom = start + 2
    const labelTo = labelFrom + label.length
    const markerEnd = start + match[0].length

    cx.addLeafElement(
      leaf,
      cx.elt(FOOTNOTE_NODES.definition, start, start + leaf.content.length, [
        cx.elt(FOOTNOTE_NODES.mark, start, labelFrom), // `[^`
        cx.elt(FOOTNOTE_NODES.label, labelFrom, labelTo),
        cx.elt(FOOTNOTE_NODES.mark, labelTo, markerEnd), // `]:`
        ...cx.parser.parseInline(leaf.content.slice(match[0].length), markerEnd),
      ]),
    )
    return true
  }
}

export const footnoteExtension: MarkdownConfig = {
  defineNodes: [
    { name: FOOTNOTE_NODES.ref, style: tags.link },
    { name: FOOTNOTE_NODES.definition, block: true },
    { name: FOOTNOTE_NODES.label, style: tags.labelName },
    { name: FOOTNOTE_NODES.mark, style: tags.processingInstruction },
  ],

  parseInline: [
    {
      name: FOOTNOTE_NODES.ref,
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== BRACKET_OPEN) return -1
        const end = scanRef((p) => cx.char(p), pos, cx.end)
        if (end < 0) return -1

        const elements: Element[] = [
          cx.elt(FOOTNOTE_NODES.mark, pos, pos + 2), // `[^`
          cx.elt(FOOTNOTE_NODES.label, pos + 2, end - 1),
          cx.elt(FOOTNOTE_NODES.mark, end - 1, end), // `]`
        ]
        return cx.addElement(cx.elt(FOOTNOTE_NODES.ref, pos, end, elements))
      },
      // 必须抢在 Link 前面：否则 `[^1]` 会被当成一个没有目标的链接
      before: 'Link',
    },
  ],

  parseBlock: [
    {
      name: FOOTNOTE_NODES.definition,
      leaf(_cx: BlockContext, leaf: LeafBlock) {
        return DEFINITION.test(leaf.content) ? new FootnoteDefinitionParser() : null
      },
      /**
       * 一行新的 `[^x]:` 要打断上一个叶子块。
       *
       * 不加这条的话，连续写的多条脚注定义会被惰性延续粘成一条 ——
       * 而连续写正是脚注定义最常见的排布方式。
       */
      endLeaf(_cx: BlockContext, line): boolean {
        return DEFINITION.test(line.text.slice(line.pos))
      },
      // 抢在链接引用定义前面：`[^1]: 内容` 否则会被解析成 LinkReference，
      // 「内容」被当作 URL
      before: 'LinkReference',
    },
  ],
}
