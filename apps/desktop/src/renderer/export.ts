/**
 * 导出：把当前文档变成一份能发出去的 HTML（docs/design/06 §2）。
 *
 * 转换本身在 `@mosu/export` 里（纯函数、可脱离 Electron 单测）；
 * 这个文件负责**只有宿主才做得到的那几件事**：
 *
 * - 采集当前主题的实际配色；
 * - 把图片读成 data URI；
 * - 调 mermaid 把图渲染成 SVG；
 * - 把 KaTeX 的样式与字体内联进去。
 *
 * ## 「自包含」的标准
 *
 * 一个文件发出去，收件人双击就能看。所以外链一律不许有 —— 包括字体。
 * KaTeX 的样式表引用二十来个 woff2，不内联的话公式在别人机器上是一堆方框。
 */
import {
  PRINT_FONT_CSS,
  buildDocument,
  markdownToHtmlFragment,
  type ExportHooks,
} from '@mosu/export'
import { THEME_VARIABLES, type ThemeId } from './theme.js'

/**
 * 采集当前生效的主题变量。
 *
 * 直接读**计算值**而不是把 themes.css 原样搬过去：用户可能选的是「跟随系统」，
 * 也可能将来用了自定义主题 —— 计算值才是「他此刻看到的样子」，
 * 而那正是他期望导出的东西。
 */
function themeCss(force?: ThemeId): string {
  // 取值的元素：不指定主题时就是文档根（= 用户此刻看到的样子）；
  // 指定时挂一个临时探针，靠 themes.css 里 `[data-mosu-theme='…']` 的定义取值。
  // 探针必须真的进文档 —— 游离元素没有计算样式。
  let probe: HTMLElement = document.documentElement
  if (force) {
    probe = document.createElement('div')
    probe.dataset['mosuTheme'] = force
    probe.style.display = 'none'
    document.body.appendChild(probe)
  }

  try {
    const computed = getComputedStyle(probe)
    const lines = THEME_VARIABLES.map((name) => {
      const value = computed.getPropertyValue(`--mosu-${name}`).trim()
      return value ? `  --mosu-${name}: ${value};` : ''
    }).filter(Boolean)

    return `:root {\n${lines.join('\n')}\n}`
  } finally {
    if (force) probe.remove()
  }
}

/** 页面上加载过的 KaTeX 样式表地址；没渲染过公式时为 null。 */
function katexStylesheetHref(): string | null {
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.href?.includes('katex')) return sheet.href
  }
  return null
}

async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * 取 KaTeX 样式并把字体一并内联。
 *
 * 字体不内联的话公式在别人机器上会变成方框 —— 那还不如不导出公式样式。
 * 任何一个字体取不到就跳过它（保留原 url），不因为一个字体失败而放弃整张表。
 */
async function katexCss(): Promise<string | null> {
  const href = katexStylesheetHref()
  if (!href) return null

  let text: string
  try {
    const response = await fetch(href)
    if (!response.ok) return null
    text = await response.text()
  } catch {
    return null
  }

  const urls = [...text.matchAll(/url\(([^)]+)\)/g)].map((m) =>
    (m[1] ?? '').replace(/['"]/g, ''),
  )
  const unique = [...new Set(urls)].filter((u) => u && !u.startsWith('data:'))

  const resolved = await Promise.all(
    unique.map(async (relative) => {
      const absolute = new URL(relative, href).toString()
      return [relative, await fetchAsDataUri(absolute)] as const
    }),
  )

  let out = text
  for (const [relative, dataUri] of resolved) {
    if (dataUri) out = out.split(relative).join(dataUri)
  }
  return out
}

export interface ExportContext {
  /** 当前文档的 Markdown 源码。 */
  markdown: string
  /** 页面标题，通常是文件名。 */
  title: string
  /** 文档所在目录，用于解析相对图片路径；未保存时为 null。 */
  baseDir: string | null
  /** 把相对路径解析成可 fetch 的 URL（宿主的资源协议）。 */
  resolveAsset: (src: string, baseDir: string) => string
  /** 渲染 mermaid 图。由渲染进程注入 —— mermaid 只在那边加载过。 */
  renderDiagram?: (code: string) => Promise<string | null>
}

function hooksFor(context: ExportContext): ExportHooks {
  const hooks: ExportHooks = {}

  if (context.baseDir) {
    const baseDir = context.baseDir
    hooks.inlineImage = async (src) => {
      // 绝对 URL（http、data）原样保留：它们本来就不依赖本地文件
      if (/^[a-z][a-z\d+.-]*:/i.test(src)) return null
      return fetchAsDataUri(context.resolveAsset(src, baseDir))
    }
  }
  if (context.renderDiagram) hooks.renderDiagram = context.renderDiagram

  return hooks
}

/**
 * 生成一份自包含的 HTML 文档。
 *
 * **只在文档真的有公式时才内联 KaTeX 那一整套。** 那套样式带着二十来个 woff2
 * 的 base64，几 MB 起步 —— 一篇没有任何公式的文档背着它，产物大小要翻几十倍，
 * 而多出来的字节一个都用不上。
 *
 * 判据放在片段上而不是原文上 —— `rehypeKatex` 只有真渲染出公式时才会打上
 * `katex` 类，比在 Markdown 里数 `$` 靠谱得多。
 */
export async function exportHtmlDocument(
  context: ExportContext,
  options: { theme?: ThemeId; viewport?: boolean; printFonts?: boolean } = {},
): Promise<string> {
  const fragment = await markdownToHtmlFragment(context.markdown, hooksFor(context))
  const katex = fragment.includes('katex') ? await katexCss() : null

  // 字体覆盖必须排在主题**后面** —— 它靠「同一选择器、后来者胜」压住主题
  // 采集到的那份字体栈
  const css = [themeCss(options.theme)]
  if (katex) css.push(katex)
  if (options.printFonts) css.push(PRINT_FONT_CSS)

  return buildDocument(fragment, {
    title: context.title,
    css,
    ...(options.viewport === false ? { viewport: false } : {}),
  })
}

/**
 * 给 PDF 用的 HTML。跟给人看的那一份有两处不同：
 *
 * - **一律浅色**。深色主题打出来是一整页黑，既费墨也几乎读不了。
 *   应用自己的打印样式（themes.css 的 `@media print`）已经这么做了，
 *   导出的 PDF 没有理由不一致。真要深色 PDF，可以先导出 HTML 再自己打印。
 * - **不带 viewport meta**。PDF 没有「设备宽度」这回事，让布局去迁就一个从不
 *   显示的窗口有多宽，只会让产物取决于无关的东西。
 * - **换掉正文字体**。`system-ui` 在 macOS 上解析到一个拿不到字形轮廓的系统
 *   字体，Chromium 于是一个字都画不进 PDF —— 整页空白。见 `PRINT_FONT_CSS`。
 */
export async function exportPdfHtml(context: ExportContext): Promise<string> {
  return exportHtmlDocument(context, { theme: 'light', viewport: false, printFonts: true })
}

/**
 * 生成「复制为富文本」用的片段。
 *
 * 只要片段，不要外壳：往剪贴板写整份带 `<head>` 的文档，
 * 粘进 Word 会多出一堆空行。样式靠内联 —— 目标应用不会带上我们的 CSS。
 */
export async function exportHtmlFragment(context: ExportContext): Promise<string> {
  return markdownToHtmlFragment(context.markdown, hooksFor(context))
}
