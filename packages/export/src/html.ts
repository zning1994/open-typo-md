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
import { materializeRawHtml, wrapLooseText } from './raw-html.js'
import { collapseKatex, inlineFragmentStyles } from './fragment-style.js'

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
  /**
   * 产物是要粘进**别人的**文档的（「复制为富文本」）。
   *
   * 打开时把关键排版摊成 `style` 属性、把 KaTeX 的三份并行表示收敛成一份。
   * 详见 fragment-style.ts —— 后者不是样式问题，不做的话公式粘出去是乱码。
   *
   * 默认关：自包含 HTML 文档那条路会把整份 CSS 内联进 `<head>`，
   * 再摊一遍行内样式只会让产物变大、还压不住主题。
   */
  forFragment?: boolean
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
 *
 * ## 三处对默认表的必要偏离
 *
 * **1. `mark` 与 `u` 要加进 `tagNames`**（issue #1）。默认表里没有这两个，
 * 而它们在行内 HTML 白名单里 —— 不加的话 `<mark>x</mark>` 刚被
 * `materializeRawHtml` 变成真元素，转头就被消毒器拆掉，白忙一场。
 *
 * **2. `clobberPrefix` 要清空**（issue #11）。`mdast-util-to-hast` 已经用
 * `user-content-` 处理过脚注的 `id` **和** `href` 了；消毒器再跑一遍，
 * 而它的 clobber 列表是 `[ariaDescribedBy, ariaLabelledBy, id, name]` ——
 * **`href` 不在里面**。于是 `id` 被加了第二次前缀而 `href` 没有，
 * 导出文件里每一个脚注跳转和返回链接都指向不存在的锚点。
 *
 * 清掉之后 clobber 防护并没有变弱：树里唯一带 `id` 的就是脚注，
 * 而用户手写 HTML 的属性早在 `materializeRawHtml` 那一步就没了
 * （白名单只认**不带任何属性**的标签）。
 *
 * **3. `protocols.src` 要放开 `data:` 和 `file:`**（issue #12）。默认只允许
 * `http`/`https`，于是 `![](data:image/png;base64,…)` 的 `src` 在
 * `applyHooks` 看到它**之前**就被删了，只剩一个光秃秃的 `<img alt>` ——
 * 比留着原 URL 更糟，连丢了什么的线索都没有。
 *
 * 而 `data:` 图片本来就是自包含的，正是这个导出器努力想产出的形态。
 * 只放开 `src`，不放开 `href`：`<a href="data:text/html,…">` 是钓鱼载体，
 * 而 `<img src="data:">` 在现代浏览器里连脚本都跑不了。
 */
function schema(): typeof defaultSchema {
  return {
    ...defaultSchema,
    clobberPrefix: '',
    tagNames: [...(defaultSchema.tagNames ?? []), 'mark', 'u'],
    protocols: {
      ...defaultSchema.protocols,
      src: [...(defaultSchema.protocols?.['src'] ?? []), 'data', 'file'],
    },
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
 * 把 `src` 还原成用户在源码里写的样子（issue #13）。
 *
 * `mdast-util-to-hast` 会对 `image.url` 跑 `normalizeUri()`，所以到这里时
 * `图片.png` 已经变成 `%E5%9B%BE%E7%89%87.png` 了。宿主拿着这串东西去
 * `path.resolve(base, src)`，找的是一个**字面量叫 `%E5%9B%BE%E7%89%87.png`
 * 的文件** —— 永远找不到。表现是：编辑器里图片好好的，一导出就变成悬空引用，
 * 而「自包含」这个承诺对所有非 ASCII / 带空格的文件名都不成立。
 *
 * 不对称是可证的：编辑器实时预览那条路径传给同一个 `buildAssetUrl` 的是
 * **原始**源码片段，所以屏幕上没问题，只在导出时消失。
 *
 * 解不动就原样交出去：`decodeURIComponent` 遇到落单的 `%` 会抛
 * （`50%.png` 就是），那种情况下原串本来就是对的。
 */
function decodePath(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
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
          hooks.inlineImage(decodePath(src)).then((uri) => {
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

  if (!options.allowRawHtml) {
    // **顺序是有讲究的。** 先把 `raw` 节点定性（白名单内的变成真元素，
    // 其余变成文本），再消毒。
    //
    // 反过来做不行：消毒器对 `raw` 节点的处置是**整个丢掉**，跑在前面的话
    // 后面就没有东西可以定性了 —— 那正是 issue #1 的现场（管线里压根没有
    // 这一步，`rehypeStringify` 在 allowDangerousHtml 关闭时把 raw 全吃了）。
    //
    // 也不能反过来担心「先变成元素就绕过了消毒」：`materializeRawHtml` 只认
    // 一个封闭的、**不带任何属性**的标签集合，产出的元素比消毒器的白名单还窄，
    // 而消毒器随后照样再过一遍。
    processor.use(() => (tree: Root) => {
      materializeRawHtml(tree)
      wrapLooseText(tree)
    })
    processor.use(rehypeSanitize, schema())
  }

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

  if (options.forFragment) {
    // 都排在 applyHooks **之后**：内联样式要盖到图片和图表的产物上，
    // 而 KaTeX 的收敛必须等 rehypeKatex 跑完（它在 run 阶段）
    collapseKatex(tree)
    inlineFragmentStyles(tree)
  }

  return processor.stringify(tree) as string
}
