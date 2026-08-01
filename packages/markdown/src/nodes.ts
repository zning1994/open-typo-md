/**
 * Lezer Markdown 的节点名常量与分类。
 *
 * 单独抽出来的原因：装饰规则（@typo/editor）需要按节点名分发，
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
  table: 'Table',
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
