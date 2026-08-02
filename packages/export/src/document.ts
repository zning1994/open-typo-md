/**
 * 自包含单文件 HTML（docs/design/06 §2）。
 *
 * 「自包含」的标准是：**这一个文件发出去，收件人双击就能看**。
 * 意味着样式内联、图片转 data URI、字体也不能外链。
 *
 * 字体是这里最容易被忽略的一环：KaTeX 的 CSS 引用二十来个 woff2，
 * 外链的话公式在别人机器上会变成一堆方框。所以调用方要把字体也一并内联进
 * `css` 里（宿主才有读文件的能力，见 06 §2 的自包含模式）。
 */

export interface DocumentOptions {
  /** 页面标题，通常是文件名。 */
  title: string
  /** 已经内联好的 CSS。多份按顺序拼接。 */
  css?: readonly string[]
  /** 正文宽度，跟编辑器里的 `--mosu-content-width` 对应。 */
  contentWidth?: string
  /**
   * 是否带 `<meta name="viewport">`。默认带。
   *
   * 给人看的 HTML 要带 —— 那是一份真的网页，会在手机上被打开。
   * 打印 / 转 PDF 那一份不带：PDF 没有「设备宽度」这回事，
   * 让布局去迁就一个从不显示的窗口有多宽，只会让产物取决于无关的东西。
   */
  viewport?: boolean
  /**
   * `<html lang>`。**默认不写**。
   *
   * 我们并不知道用户这篇文档是什么语言 —— 编辑器界面是中文，不代表内容是。
   * 写一个错的 `lang` 比不写更糟：读屏软件会用错发音，浏览器会用错断词规则。
   *
   * 曾经这里写死着 `zh-CN`，一度被当成 macOS 上 PDF 空白页的根因（合成文档的
   * 二分里，只有带 `lang` 的变体画不出字）。去掉它并没有修好那个缺陷 ——
   * 见 06 §3.3。改动本身仍然保留，因为写死这个值本来就不对。
   */
  lang?: string
}

/**
 * 打印专用的字体覆盖 —— **macOS 上 PDF 空白页的根因就在这里**。
 *
 * ## 根因：`PingFang SC` 画不进 PDF
 *
 * macOS 上默认的中文无衬线字体是 PingFang SC。Chromium 的 PDF 后端**画不出它的
 * 任何字形** —— 连拉丁字母都画不出（实测把 `font-family` 直接写成
 * `'PingFang SC'`，一篇纯英文文档同样是空白）。
 *
 * 而字体匹配是**逐字形**的：正文字体栈里那些拉丁字体（`system-ui`、`Helvetica`、
 * `Arial`、以及泛型 `sans-serif`）都没有汉字，于是每一个汉字都回退到系统默认的
 * 中文无衬线字体，也就是 PingFang SC。结果就是**一篇中文文档整页空白**：
 * 版面照排（长文档确实分了页）、底色照画，就是一个 `Tj` 都没有。
 *
 * 三平台 CI 上量出来的对照（拉丁 / 中文）：
 *
 * ```
 * system-ui        true  / false      serif、Times      true / true
 * Helvetica、Arial  true  / false      'Songti SC'       true / true
 * sans-serif       true  / false      'Hiragino Sans GB' true / true
 * 'PingFang SC'    false / false      Arial, 'Songti SC' true / true
 * ```
 *
 * `serif` 系没事，是因为它的中文回退是 Songti SC 而不是 PingFang。
 *
 * ## 修法：把能画的中文字体显式插进栈里
 *
 * 相对主题里那份字体栈，**唯一的改动是把 `'PingFang SC'` 换成
 * `'Hiragino Sans GB', 'Songti SC'`**。位置很要紧：它必须排在泛型
 * （`sans-serif` / `monospace`）**前面** —— 泛型在 macOS 上给出的中文字体
 * 正是 PingFang，排在它后面等于没写。
 *
 * 拉丁那一半原样保留（`system-ui` 本身是清白的，它的拉丁字形画得出来），
 * 所以 PDF 与屏幕上的观感不会分家。
 *
 * 只作用于 PDF。给人看的 HTML 不动：那是一份真的网页，在收件人机器上用系统
 * 字体渲染才是对的，而浏览器显示 PingFang 没有任何问题。
 */
export const PRINT_FONT_CSS = `:root {
  --mosu-font-body:
    system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans GB', 'Songti SC',
    'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;
  --mosu-font-mono:
    'JetBrains Mono', ui-monospace, Menlo, Consolas, 'Hiragino Sans GB', 'Songti SC',
    'Microsoft YaHei', monospace;
}`

/**
 * HTML 文本转义。
 *
 * 只用于我们自己拼进模板的字段（标题）。正文那一侧由 rehype 负责转义 ——
 * 在这里再转一次会把已经正确的 HTML 变成一堆 `&lt;`。
 */
function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 兜底样式。
 *
 * 刻意只有排版骨架，没有配色 —— 配色由调用方传进来的主题 CSS 决定。
 * 但**必须有一份兜底**：没有它时导出的文件会是浏览器默认的 Times New Roman
 * 顶到屏幕边缘，看起来像是导坏了。
 */
const BASE_CSS = `
:root {
  --mosu-content-width: 42em;
  color-scheme: light dark;
}
body {
  margin: 0;
  padding: 2.5rem 1.5rem 6rem;
  font-family: var(--mosu-font-body, system-ui, -apple-system, 'PingFang SC', sans-serif);
  font-size: var(--mosu-font-size, 16px);
  line-height: var(--mosu-line-height, 1.7);
  color: var(--mosu-fg, #24292f);
  background: var(--mosu-bg, #fff);
}
main {
  max-width: var(--mosu-content-width);
  margin: 0 auto;
}
img { max-width: 100%; height: auto; }
pre {
  overflow-x: auto;
  padding: 0.8em 1em;
  border-radius: 6px;
  background: var(--mosu-code-bg, #f0f2f4);
}
code { font-family: var(--mosu-font-mono, ui-monospace, Menlo, Consolas, monospace); }
pre code { background: none; padding: 0; }
:not(pre) > code {
  padding: 0.1em 0.32em;
  border-radius: 4px;
  background: var(--mosu-code-bg, #f0f2f4);
}
blockquote {
  margin: 1em 0;
  padding-left: 1em;
  border-left: 3px solid var(--mosu-border, #d0d7de);
  color: var(--mosu-fg-muted, #6e7781);
}
table { border-collapse: collapse; }
th, td { border: 1px solid var(--mosu-border, #d0d7de); padding: 0.35em 0.7em; }
hr { border: 0; border-top: 1px solid var(--mosu-border, #d0d7de); }
.mosu-diagram { margin: 1em 0; text-align: center; }
.mosu-frontmatter {
  font-size: 0.85em;
  color: var(--mosu-fg-muted, #6e7781);
  border-left: 3px solid var(--mosu-border, #d0d7de);
}
`.trim()

/** 把 HTML 片段包成一份可以直接分发的单文件文档。 */
export function buildDocument(fragment: string, options: DocumentOptions): string {
  const styles = [BASE_CSS, ...(options.css ?? [])].join('\n\n')
  const width = options.contentWidth
    ? `\n<style>:root { --mosu-content-width: ${escapeText(options.contentWidth)}; }</style>`
    : ''

  const viewport =
    options.viewport === false
      ? ''
      : '\n<meta name="viewport" content="width=device-width, initial-scale=1">'
  const lang = options.lang ? ` lang="${escapeText(options.lang)}"` : ''

  return `<!doctype html>
<html${lang}>
<head>
<meta charset="utf-8">${viewport}
<meta name="generator" content="Mosu">
<title>${escapeText(options.title)}</title>
<style>
${styles}
</style>${width}
</head>
<body>
<main>
${fragment}
</main>
</body>
</html>
`
}
