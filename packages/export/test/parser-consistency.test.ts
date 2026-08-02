/**
 * 两个解析器的一致性（ADR-0003 缓解措施第 1 条）。
 *
 * ADR-0003 选了双解析器：编辑期用 `@lezer/markdown` 求增量与位置精确，导出期用
 * remark/mdast 求语义完整与生态。那份 ADR 把这条测试写成**「决策的一部分，
 * 不是可选项」** —— 因为不一致的后果用户会当成 bug 而且查不出来：
 *
 * > 编辑器把某段显示成引用块（Lezer 判定），导出的 HTML 里却是普通段落
 * > （remark 判定）。
 *
 * 这条测试欠了从 M3 到 M4.5 整整三档。补上它的难点从来不是「跑用例」，
 * 是两边的**节点词汇不一样**：Lezer 说 `ATXHeading2`，mdast 说
 * `heading{depth:2}`；Lezer 把围栏代码和缩进代码分成 `FencedCode` / `CodeBlock`，
 * mdast 一律叫 `code`。所以得先有一层规范化映射，见下面两张表。
 *
 * ## 比什么、不比什么
 *
 * **只比块级骨架。** 行内元素（强调、链接、代码片段）不比：CommonMark 的
 * 分隔符左右侧规则本身就有大量边角，两边的行内节点结构差异更大，而那些差异
 * 对用户的影响远小于「这一段到底是不是引用块」。ADR 里写的也是「比对块级结构树」。
 *
 * **不比文本内容。** 这条测试问的是「结构判定是否一致」，不是「内容是否相同」——
 * 后者由 `fidelity.test.ts` 的字节保真覆盖。
 *
 * ## 为什么放在 `@typo/export` 下面
 *
 * 分层规则（01 §1）里，`@typo/export` 是**唯一同时看得见两个解析器**的包：
 * remark 是它自己的依赖，`@typo/markdown` 是它允许依赖的下层。放在 `@typo/editor`
 * 里会反过来违反「导出不依赖编辑器」。
 */
import { describe, expect, it } from 'vitest'
import spec from 'commonmark-spec'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { markdownLanguageSupport } from '@typo/markdown'

interface SpecExample {
  markdown: string
  section: string
  number: number
}

const examples = (spec as unknown as { tests: SpecExample[] }).tests

/**
 * Lezer 节点名 → 规范化的块类型。
 *
 * 不在这张表里的节点一律**跳过**，而不是报错：Lezer 的树里除了块，还有大量
 * 语法标记（`HeaderMark`、`ListMark`、`QuoteMark`）与行内节点，它们本来就不该
 * 参与块级比对。跳过是这层映射的正常工作方式，不是「漏了」。
 */
const LEZER_BLOCKS: Record<string, string> = {
  Document: 'doc',
  Paragraph: 'p',
  ATXHeading1: 'h1',
  ATXHeading2: 'h2',
  ATXHeading3: 'h3',
  ATXHeading4: 'h4',
  ATXHeading5: 'h5',
  ATXHeading6: 'h6',
  SetextHeading1: 'h1',
  SetextHeading2: 'h2',
  Blockquote: 'quote',
  BulletList: 'ul',
  OrderedList: 'ol',
  ListItem: 'li',
  // 围栏与缩进在 mdast 里是同一个 `code`，这里也合并 —— 两者的**语义**相同，
  // 差别只在写法，而这条测试比的是语义判定
  FencedCode: 'code',
  CodeBlock: 'code',
  HorizontalRule: 'hr',
  HTMLBlock: 'html',
  CommentBlock: 'html',
  ProcessingInstructionBlock: 'html',
  LinkReference: 'def',
  Table: 'table',
  TableHeader: 'row',
  TableRow: 'row',
  TableCell: 'cell',
  /**
   * GFM 任务项：`- [ ] 待办`。
   *
   * Lezer 在 ListItem 里用 `Task` **代替** `Paragraph` 装内容（实测：
   * `ListItem > Task > TaskMarker`，而普通项是 `ListItem > Paragraph`），
   * mdast 那边仍然是 `listItem > paragraph`，勾选状态挂在 listItem 的
   * `checked` 属性上。两者语义相同，只是命名不同 —— 所以映射到同一个 `p`。
   * 不映的话所有任务列表用例都会被判成分歧，而那是纯粹的词汇差异。
   */
  Task: 'p',
}

/**
 * **叶子块**：它们的子节点全是行内元素，比对到此为止，不再下钻。
 *
 * 这一条不是优化，是**正确性**。mdast 用同一个 `html` 类型表示块级 HTML 与
 * 行内 HTML（`<del>*foo*</del>` 里那个），而 Lezer 把后者叫 `HTMLTag`，不在
 * 块表里。不停在叶子块上的话，六七个用例会因为「mdast 在段落里多报了一个
 * html」而被判成分歧 —— 那是映射的锅，不是解析器的分歧。
 */
const LEAF_BLOCKS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'code',
  'hr',
  'def',
  'html',
  'cell',
])

/** mdast 类型 → 规范化的块类型。`heading` 与 `list` 要看属性，单独处理。 */
const MDAST_BLOCKS: Record<string, string> = {
  root: 'doc',
  paragraph: 'p',
  blockquote: 'quote',
  listItem: 'li',
  code: 'code',
  thematicBreak: 'hr',
  html: 'html',
  definition: 'def',
  table: 'table',
  tableRow: 'row',
  tableCell: 'cell',
}

const lezerParser = (gfm: boolean) =>
  markdownLanguageSupport({
    dialect: gfm ? 'gfm' : 'commonmark',
    // front matter 与数学是我们自己加的扩展，remark 那侧要另配插件才对等。
    // 这条测试要比的是**共同的基线**，所以两边都关掉
    frontmatter: false,
    math: false,
  }).language.parser

function lezerSkeleton(text: string, gfm = false): string {
  const lines: string[] = []
  const stack: string[] = []

  lezerParser(gfm)
    .parse(text)
    .iterate({
      enter(node) {
        const kind = LEZER_BLOCKS[node.name]
        if (!kind) return true
        lines.push(`${'  '.repeat(stack.length)}${kind}`)
        if (LEAF_BLOCKS.has(kind)) return false // 叶子块：不下钻，见 LEAF_BLOCKS
        stack.push(kind)
        return true
      },
      leave(node) {
        const kind = LEZER_BLOCKS[node.name]
        if (kind && !LEAF_BLOCKS.has(kind)) stack.pop()
      },
    })
  return lines.join('\n')
}

interface MdastNode {
  type: string
  depth?: number
  ordered?: boolean
  children?: MdastNode[]
}

function mdastKind(node: MdastNode): string | null {
  if (node.type === 'heading') return `h${node.depth ?? 1}`
  if (node.type === 'list') return node.ordered ? 'ol' : 'ul'
  return MDAST_BLOCKS[node.type] ?? null
}

function mdastSkeleton(text: string, gfm = false): string {
  const processor = gfm ? unified().use(remarkParse).use(remarkGfm) : unified().use(remarkParse)
  const root = processor.parse(text) as unknown as MdastNode

  const lines: string[] = []
  const walk = (node: MdastNode, depth: number): void => {
    const kind = mdastKind(node)
    if (kind) lines.push(`${'  '.repeat(depth)}${kind}`)
    if (kind && LEAF_BLOCKS.has(kind)) return // 叶子块：不下钻，见 LEAF_BLOCKS
    // 不认识的节点（行内元素）不占层级，直接下钻 —— 否则缩进会跟 Lezer 那侧错开
    const next = kind ? depth + 1 : depth
    for (const child of node.children ?? []) walk(child, next)
  }
  walk(root, 0)
  return lines.join('\n')
}

/** 一个用例的比对结果。 */
interface Divergence {
  number: number
  section: string
  markdown: string
  lezer: string
  mdast: string
}

function compare(examples: readonly SpecExample[], gfm: boolean): Divergence[] {
  const found: Divergence[] = []
  for (const example of examples) {
    const lezer = lezerSkeleton(example.markdown, gfm)
    const mdast = mdastSkeleton(example.markdown, gfm)
    if (lezer !== mdast) {
      found.push({
        number: example.number,
        section: example.section,
        markdown: example.markdown,
        lezer,
        mdast,
      })
    }
  }
  return found
}

/** 差异压成人能读的形式 —— 直接 diff 整棵树在断言失败时刷屏。 */
function summarize(divergences: readonly Divergence[]): string[] {
  return divergences.map(
    (d) =>
      `#${d.number}（${d.section}）\n` +
      `  源码: ${JSON.stringify(d.markdown)}\n` +
      `  Lezer: ${d.lezer.replace(/\n/g, ' / ')}\n` +
      `  mdast: ${d.mdast.replace(/\n/g, ' / ')}`,
  )
}

describe('规范化映射本身', () => {
  // 映射写错了会让整份比对变成「比了个寂寞」—— 先证明它对最常见的结构是对的
  it('常见块结构两边给出同一份骨架', () => {
    const text =
      '# 标题\n\n正文\n\n> 引用\n>\n> 第二段\n\n- 甲\n- 乙\n\n```js\ncode\n```\n\n---\n'
    expect(lezerSkeleton(text)).toBe(mdastSkeleton(text))
    expect(lezerSkeleton(text)).toContain('h1')
    expect(lezerSkeleton(text)).toContain('quote')
    expect(lezerSkeleton(text)).toContain('code')
  })

  it('嵌套结构的层级也一致', () => {
    const text = '- 甲\n  - 乙\n    > 引用\n'
    expect(lezerSkeleton(text)).toBe(mdastSkeleton(text))
  })

  it('Setext 与 ATX 标题归一到同一个层级', () => {
    expect(lezerSkeleton('标题\n===\n')).toBe(mdastSkeleton('标题\n===\n'))
    expect(lezerSkeleton('标题\n===\n')).toBe(lezerSkeleton('# 标题\n'))
  })

  it('围栏代码与缩进代码归一成同一种', () => {
    expect(lezerSkeleton('```\nx\n```\n')).toBe(lezerSkeleton('    x\n'))
  })

  it('真有差异时必须被发现 —— 反证这套比对不是恒等式', () => {
    // 手工构造一份「骨架不同」的输入，确认 compare 不会放过它
    expect(lezerSkeleton('# 标题\n')).not.toBe(mdastSkeleton('正文\n'))
  })
})

/**
 * **已知差异**：确实存在、暂时不修，但每一条都必须登记（ADR-0003 缓解措施第 3 条）。
 *
 * 键是 CommonMark spec 的用例编号，值是一句话说明。完整的分析（谁对、用户会看到
 * 什么、为什么暂不修）在 `docs/known-divergences.md`。
 *
 * 这张表**两个方向都卡**：
 *
 * - 出现表外的新差异 → 失败（防止分歧悄悄增加）；
 * - 表内的某条不再有差异 → **也失败**（上游修好了就该把它从表里删掉）。
 *
 * 第二条是这张表不腐烂的唯一保证。只卡第一个方向的允许清单，几年后会变成一份
 * 谁也不敢动的化石 —— 里面一半的条目早就不成立了，但没人知道是哪一半。
 */
const KNOWN_DIVERGENCES: Record<number, string> = {
  171: '<textarea> 未被 Lezer 认作 type-1 HTML 块，整块被拆开',
  280: '「- 空项 + 空行 + 缩进段落」中，Lezer 把段落并进了列表项',
}

describe('CommonMark 官方语料（652 例）', () => {
  const divergences = compare(examples, false)
  const byNumber = new Map(divergences.map((d) => [d.number, d]))

  it('语料库本身加载正常', () => {
    expect(examples.length).toBeGreaterThan(600)
  })

  it('除了已登记的两条，两个解析器的块级判定完全一致', () => {
    const unexpected = divergences.filter((d) => !(d.number in KNOWN_DIVERGENCES))
    expect(summarize(unexpected)).toEqual([])
  })

  it('已登记的差异**依然存在** —— 上游修好了就该把它从清单里删掉', () => {
    const stale = Object.keys(KNOWN_DIVERGENCES)
      .map(Number)
      .filter((number) => !byNumber.has(number))
      .map((number) => `#${number} 已不再有差异：${KNOWN_DIVERGENCES[number]}`)
    expect(stale).toEqual([])
  })

  it('分歧总数不超过登记的条数 —— 这个数字本身就是一个应当被盯住的指标', () => {
    expect(divergences.length).toBe(Object.keys(KNOWN_DIVERGENCES).length)
  })
})

describe('GFM 扩展', () => {
  // 官方语料里没有表格，GFM 那几样得自己给用例。数量不多，
  // 但覆盖的正是「两个解析器各自实现的扩展」—— 分歧风险最高的地方
  const gfmExamples: SpecExample[] = [
    { section: 'table', number: 1001, markdown: '| a | b |\n| --- | --- |\n| 1 | 2 |\n' },
    { section: 'table', number: 1002, markdown: '| a |\n| :-- |\n| 1 |\n| 2 |\n' },
    {
      section: 'table',
      number: 1003,
      markdown: '前面一段\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后面一段\n',
    },
    // 单元格数量不一致：解析器不补齐（见 @typo/markdown 的 TABLE_NODES 注释）
    { section: 'table', number: 1004, markdown: '| a | b |\n| --- | --- |\n| 1 |\n' },
    { section: 'task-list', number: 1010, markdown: '- [ ] 待办\n- [x] 完成\n' },
    { section: 'task-list', number: 1011, markdown: '- [ ] 待办\n  - [x] 子项\n' },
    { section: 'strikethrough', number: 1020, markdown: '~~删除~~ 正文\n' },
    { section: 'autolink', number: 1030, markdown: '访问 https://example.com 看看\n' },
  ]

  const divergences = compare(gfmExamples, true)

  it('表格、任务列表、删除线、自动链接的块级结构一致', () => {
    expect(summarize(divergences)).toEqual([])
  })
})
