/**
 * Markdown → HTML（docs/design/06 §2）。
 *
 * 这里是**语义解析器**那一侧（ADR-0003）：编辑期用 `@lezer/markdown` 求增量与
 * 位置精确，导出期用 remark/mdast 求语义完整与生态。
 *
 * ## 消毒是这条管线里最不能省的一步
 *
 * 用户文档里可以写任何 HTML，包括 `<script>` 和 `onerror=`。导出产物是要
 * **发给别人**的 —— 它会被丢进浏览器、贴进邮件、传上内网。
 * 所以默认一律消毒，且规则是「允许什么」而不是「禁止什么」：
 * 黑名单永远漏，而漏掉的那一条就是别人机器上的一次 XSS。
 *
 * 想保留原始 HTML 的用户必须**显式**打开开关（06 §2）。
 * 这不是可以「默认开着方便点」的东西。
 *
 * ## 为什么不复用编辑器里已经渲染好的 DOM
 *
 * 那是最省事的做法，但会焊死两个问题：DOM 里全是 CodeMirror 的实现细节
 * （`.cm-line`、装饰包裹层），而且**视口之外的内容根本不存在** ——
 * 导出一篇长文只会得到当前屏幕上那几段。
 *
 * ## 宿主能力靠注入
 *
 * 内联图片要读文件、渲染图表要跑 mermaid，两者都不属于这一层（它必须能脱离
 * Electron 与 DOM 单测）。所以做成 `ExportHooks` 由调用方注入 ——
 * 跟编辑器里的 `assetResolver` / `imageSink` 是同一个路子。
 * 不注入时各自有明确的退化行为，不会静默丢内容。
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { fromHtml } from 'hast-util-from-html'
import { visit } from 'unist-util-visit'
import type { Element, Root } from 'hast'

export interface ExportHooks {
  /**
   * ```` ```mermaid ```` 块 → 内联 SVG 字符串。
   *
   * 不提供、或返回 null 时按普通代码块导出 —— 图没了但源码还在，
   * 收件人至少知道这里本来有张图（原则 P2）。
   */
  renderDiagram?: (code: string) => Promise<string | null>
  /**
   * 图片路径 → data URI。自包含单文件模式靠它。
   *
   * 不提供、或返回 null 时保留原路径 —— 产物不再自包含，但引用是对的。
   */
  inlineImage?: (src: string) => Promise<string | null>
}

export interface HtmlOptions extends ExportHooks {
  /**
   * 保留文档里的原始 HTML，**跳过消毒**。
   *
   * 默认关。打开它意味着导出产物里可能含有 `<script>` ——
   * 调用方必须先让用户明确确认（06 §2）。
   */
  allowRawHtml?: boolean
  /** 把 YAML front matter 也导出（默认丢弃 —— 它是元数据，不是正文）。 */
  keepFrontmatter?: boolean
}

/**
 * 消毒白名单。
 *
 * 在 rehype 的默认表（本身已相当保守）之上只放开 `class`：主题靠它上色。
 * **`style` 不放开** —— `style` 能塞进 `background: url(...)` 之类的东西，
 * 而放开它换来的只是「用户手写的行内样式能带出去」这点便利。
 *
 * KaTeX 与 Mermaid 的产物走另一条路：它们由我们自己生成、在消毒**之后**
 * 才插进树里，因此不受这张表约束（见 `applyHooks` 与 katex 的处理顺序）。
 */
function schema(): typeof defaultSchema {
  return {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className'],
    },
  }
}

/** front matter 节点在 mdast 里叫 `yaml`；默认没有 rehype handler，等于被丢弃。 */
const FRONTMATTER_HANDLER = {
  yaml(_state: unknown, node: { value: string }): Element {
    return {
      type: 'element',
      tagName: 'pre',
      properties: { className: ['mosu-frontmatter'] },
      children: [{ type: 'text', value: node.value }],
    }
  },
}

/** 代码块的语言：rehype 把它放在 `<code class="language-xxx">` 上。 */
function languageOf(code: Element): string | null {
  const classes = code.properties?.['className']
  if (!Array.isArray(classes)) return null
  for (const entry of classes) {
    const name = String(entry)
    if (name.startsWith('language-')) return name.slice('language-'.length)
  }
  return null
}

function textOf(node: Element): string {
  let out = ''
  visit(node, 'text', (text: { value: string }) => {
    out += text.value
  })
  return out
}

/**
 * 跑注入的宿主能力：图表转 SVG、图片转 data URI。
 *
 * 放在消毒**之后**：这两样的产物是我们自己生成的，不该再被白名单裁一遍
 * （SVG 会被裁得只剩骨架）。而它们的**输入**（代码块内容、图片路径）
 * 来自已消毒的树，所以不存在「绕过消毒」的通道。
 */
async function applyHooks(tree: Root, hooks: ExportHooks): Promise<void> {
  const jobs: Promise<void>[] = []

  visit(tree, 'element', (node: Element, index, parent) => {
    if (node.tagName === 'img' && hooks.inlineImage) {
      const src = node.properties?.['src']
      if (typeof src === 'string') {
        jobs.push(
          hooks.inlineImage(src).then((uri) => {
            if (uri) node.properties = { ...node.properties, src: uri }
          }),
        )
      }
      return
    }

    // ```mermaid 在 hast 里是 <pre><code class="language-mermaid">
    if (node.tagName !== 'pre' || !hooks.renderDiagram) return
    const code = node.children.find(
      (child: Element['children'][number]): child is Element =>
        child.type === 'element' && child.tagName === 'code',
    )
    if (!code || languageOf(code) !== 'mermaid') return
    if (!parent || index === undefined) return

    const source = textOf(code)
    jobs.push(
      hooks.renderDiagram(source).then((svg) => {
        if (!svg) return // 渲染不出来就保留代码块，别把内容弄没了
        const parsed = fromHtml(svg, { fragment: true })
        parent.children[index] = {
          type: 'element',
          tagName: 'figure',
          properties: { className: ['mosu-diagram'] },
          children: parsed.children,
        } as Element
      }),
    )
  })

  await Promise.all(jobs)
}

/**
 * 把 Markdown 转成 HTML **片段**（不含 `<html>` 外壳）。
 *
 * 外壳与样式内联由 `buildDocument` 负责。分开是因为「复制为富文本」只要片段：
 * 往剪贴板写整份带 `<head>` 的文档，粘进 Word 会多出一堆空行。
 */
export async function markdownToHtmlFragment(
  markdown: string,
  options: HtmlOptions = {},
): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, {
      // 只是让原始 HTML 进入 hast；留不留由后面的消毒决定
      allowDangerousHtml: true,
      ...(options.keepFrontmatter ? { handlers: FRONTMATTER_HANDLER } : {}),
    })

  if (!options.allowRawHtml) processor.use(rehypeSanitize, schema())

  // KaTeX 放在消毒之后：它产出的 MathML 与大量 style 会被白名单裁碎。
  //
  // 不传 throwOnError —— rehype-katex 的类型里把它 Omit 掉了，因为它自己就做了
  // 我们想要的降级：先按严格模式渲染，失败再以宽松模式重渲染并记一条警告。
  // 写错的公式因此会原样标红显示，跟编辑器里的行为一致（原则 P2）。
  processor.use(rehypeKatex)
  processor.use(rehypeStringify, { allowDangerousHtml: options.allowRawHtml === true })

  // 分成 parse / run / stringify 三步而不是 process()：注入的宿主能力
  // （图表、图片）要在树转成字符串**之前**跑，且它们是异步的
  const tree = (await processor.run(processor.parse(markdown))) as Root
  await applyHooks(tree, options)

  return processor.stringify(tree) as string
}
