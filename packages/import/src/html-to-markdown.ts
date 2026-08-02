/**
 * HTML → Markdown（docs/design/03 §8）。
 *
 * 跟 `@mosu/export` 正好是反方向的一条路：那边 mdast → hast → HTML，
 * 这边 HTML → hast → mdast。同一套 unified 生态，概念只有一份。
 *
 * ## 为什么是同步的
 *
 * 粘贴必须**当场**完成。异步的话就得记住「粘到哪儿」，而用户在这几毫秒里
 * 完全可能继续打字 —— 那是 `images.ts` 里靠映射锚点解决的一整类问题
 * （位置失效、选区被替换错、撤销分组乱掉）。同步转换让这类问题根本不存在。
 *
 * 代价是 parse5 与 unified 会被静态打进编辑器包，不像 KaTeX / Mermaid 那样
 * 可以懒加载。这是明知道的取舍：粘贴的手感与正确性比几百 KB 更值钱。
 *
 * ## 质量的边界
 *
 * 转换质量是个无底洞（这也是它当初被列进 M4.5 的理由）。这里的做法是
 * **为每个已知的坏来源写一条说得清楚的规则**（见 `clean.ts`），而不是追求
 * 一个通用的完美转换。失败模式是良性的：转得不够好，用户得到的是有点丑的
 * Markdown，然后手改一下 —— 不会丢内容，也不会损坏文档。
 */
import { unified } from 'unified'
import rehypeParse from 'rehype-parse'
import rehypeRemark from 'rehype-remark'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkStringify from 'remark-stringify'
import { MATH_DISPLAY, MATH_TEX, cleanTree, hasSemantics } from './clean.js'
import type { Handle } from 'hast-util-to-mdast'
import type { Element, Root } from 'hast'

/**
 * 输出风格。
 *
 * 跟编辑器里敲出来的东西保持一致很重要 —— 同一篇文档里，粘进来的列表和
 * 手写的列表如果一个用 `-` 一个用 `*`，源码看起来就像两个人写的。
 */
const STRINGIFY_OPTIONS = {
  bullet: '-',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
  rule: '-',
  listItemIndent: 'one',
  // 不硬折行：这是所见即所得编辑器，源码里的换行是语义，不是排版
  resourceLink: false,
} as const

const parser = unified().use(rehypeParse)

/**
 * `<math>` → mdast 的公式节点。
 *
 * `clean.ts` 已经把 TeX 捞进属性里了（见那边的 `normalizeMath`），这里只负责
 * 换个节点类型。没有这一步的话 `hast-util-to-mdast` 不认识 `<math>`，
 * 整棵子树会被**悄悄丢掉** —— issue #14 的回归就是这样：从 Mosu 复制为富文本
 * 再粘回 Mosu，粗体在、公式没了。
 */
const mathHandler: Handle = (_state, node) => {
  const element = node as Element
  const tex = element.properties?.[MATH_TEX]
  if (typeof tex !== 'string') return undefined
  const block = element.properties?.[MATH_DISPLAY] === 'block'
  // `math` / `inlineMath` 不在 mdast 的核心类型里（它们来自 remark-math 的
  // 类型扩展），这个 handler 的返回类型也管不到，所以这里断言一次
  return { type: block ? 'math' : 'inlineMath', value: tex } as never
}

const compiler = unified()
  .use(rehypeRemark, { handlers: { math: mathHandler } })
  .use(remarkGfm)
  // 只为了 stringify：把 `inlineMath` / `math` 写成 `$…$` 与 `$$…$$`。
  // 不加的话 mdast-util-to-markdown 不认识这两种节点，又是一次静默丢弃
  .use(remarkMath)
  .use(remarkStringify, STRINGIFY_OPTIONS)

/**
 * 超过这个大小就不转了。
 *
 * 整页网页的 `text/html` 上到几 MB 很常见，parse5 在主线程上啃它会让界面
 * 卡住肉眼可见的一段时间。宁可退回纯文本 —— 那至少是即时的，且内容还在。
 */
const MAX_HTML_BYTES = 4 * 1024 * 1024

/**
 * 把剪贴板里的 HTML 转成 Markdown。
 *
 * 返回 `null` 表示**不该走转换**，调用方应当让默认的纯文本粘贴发生。
 * 三种情况会这样：输入为空、大到会卡界面、以及转换换不来任何结构
 * （见 `hasSemantics` —— 从代码编辑器复制过来的就属于这一类）。
 */
export function htmlToMarkdown(html: string): string | null {
  if (html.length === 0 || html.length > MAX_HTML_BYTES) return null

  const cleaned = cleanTree(parser.parse(html) as Root)
  if (!hasSemantics(cleaned)) return null

  const markdown = compiler.stringify(compiler.runSync(cleaned) as never)
  const trimmed = String(markdown).replace(/\n+$/, '')
  return trimmed === '' ? null : trimmed
}
