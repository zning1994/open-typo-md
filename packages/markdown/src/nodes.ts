/**
 * Lezer Markdown 的节点名常量与分类。
 *
 * 单独抽出来的原因：装饰规则（@mosu/editor）需要按节点名分发，
 * 把字符串散落在各处会在解析器升级改名时炸得到处都是。
 */

/** 语法标记节点 —— 就是「平时该被隐藏、光标进入时显形」的那些字符。 */
export const MARK_NODES = {
  header: 'HeaderMark',
  quote: 'QuoteMark',
  list: 'ListMark',
  emphasis: 'EmphasisMark',
  code: 'CodeMark',
  link: 'LinkMark',
  strikethrough: 'StrikethroughMark',
} as const

/** 行内元素容器。 */
export const INLINE_NODES = {
  emphasis: 'Emphasis',
  strongEmphasis: 'StrongEmphasis',
  inlineCode: 'InlineCode',
  strikethrough: 'Strikethrough',
  link: 'Link',
  image: 'Image',
  url: 'URL',
  autolink: 'Autolink',
  linkTitle: 'LinkTitle',
  linkLabel: 'LinkLabel',
  escape: 'Escape',
  entity: 'Entity',
  hardBreak: 'HardBreak',
  /**
   * 行内 HTML 的**单个标签**。
   *
   * 注意它不是配对结构：`<b>粗</b>` 出来的是两个平级的 `HTMLTag`，
   * 中间的文字跟它们是兄弟。要配对得自己扫（见 @mosu/editor 的 inline-html.ts）。
   */
  htmlTag: 'HTMLTag',
} as const

/** 块级元素。 */
export const BLOCK_NODES = {
  paragraph: 'Paragraph',
  blockquote: 'Blockquote',
  bulletList: 'BulletList',
  orderedList: 'OrderedList',
  listItem: 'ListItem',
  fencedCode: 'FencedCode',
  codeBlock: 'CodeBlock',
  horizontalRule: 'HorizontalRule',
  htmlBlock: 'HTMLBlock',
  linkReference: 'LinkReference',
} as const

/**
 * GFM 表格。
 *
 * 结构（实测，不是照文档猜的）：
 *
 * ```
 * Table
 *   TableHeader            ← 表头行，整行
 *     TableDelimiter `|`
 *     TableCell            ← **不含**两侧填充空格
 *     …
 *   TableDelimiter         ← 分隔行整行 `| --- | :---: |`
 *   TableRow               ← 数据行，整行
 *     …
 * ```
 *
 * 两个坑：`TableDelimiter` 一名两用（单个竖线 / 整条分隔行），得靠范围区分；
 * 单元格数量**允许各行不一致**，解析器不会补齐。
 */
export const TABLE_NODES = {
  table: 'Table',
  header: 'TableHeader',
  row: 'TableRow',
  cell: 'TableCell',
  delimiter: 'TableDelimiter',
} as const

/** GFM 任务列表：`- [ ] 待办`。`Task` 是 ListItem 里包住整段内容的块节点。 */
export const TASK_NODES = {
  task: 'Task',
  marker: 'TaskMarker',
} as const

export const ATX_HEADINGS = [
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
] as const

export const SETEXT_HEADINGS = ['SetextHeading1', 'SetextHeading2'] as const

const ATX_LEVELS = new Map<string, number>(ATX_HEADINGS.map((name, i) => [name, i + 1]))
const SETEXT_LEVELS = new Map<string, number>(SETEXT_HEADINGS.map((name, i) => [name, i + 1]))

/** 节点名 → 标题层级（1–6）；不是标题则返回 0。 */
export function headingLevel(nodeName: string): number {
  return ATX_LEVELS.get(nodeName) ?? SETEXT_LEVELS.get(nodeName) ?? 0
}

export function isHeading(nodeName: string): boolean {
  return headingLevel(nodeName) > 0
}

const MARK_NAMES = new Set<string>(Object.values(MARK_NODES))

export function isMarkNode(nodeName: string): boolean {
  return MARK_NAMES.has(nodeName)
}

/**
 * 「代码上下文」节点 —— 这些节点内部不做任何行内渲染，也不做拼写检查。
 * 用户在代码块里写的 `**` 就是 `**`，不是加粗。
 */
const CODE_CONTEXT = new Set<string>([
  BLOCK_NODES.fencedCode,
  BLOCK_NODES.codeBlock,
  INLINE_NODES.inlineCode,
])

export function isCodeContext(nodeName: string): boolean {
  return CODE_CONTEXT.has(nodeName)
}
