/**
 * 从一份 Markdown 的**开头几行**里找出文档标题（issue #36）。
 *
 * 为什么不用 `extractOutline`：那一条要先把整篇文档喂给 Lezer。文件树上一屏
 * 有几十个条目，每个都全量解析一遍，只为了拿最前面那一行 —— 代价和收益差了
 * 几个数量级。所以这里是一个**只往前扫、不回头**的扫描器，调用方只要把文件
 * 开头读进来（几十 KB 足够）就行。
 *
 * 换来的代价说清楚：它认识的是**块级结构里最常见的那几种**，不是完整的
 * CommonMark。具体见下面每条规则的说明。判不出来就返回 `null`，
 * 由调用方回退到文件名 —— 绝不猜（原则 P2）。
 */

/** 围栏代码块的开合：``` 或 ~~~，允许最多三个前导空格。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/
/** ATX 标题：`# 标题`。`#` 后面必须有空白或直接结束，否则 `#hashtag` 会中招。 */
const ATX = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/
/** 收尾的那串 `#`（`### 标题 ###`）—— 它是标记，不是内容。 */
const ATX_CLOSING = /\s+#+\s*$/
/** Setext 下划线：`===` 或 `---`。 */
const SETEXT = /^ {0,3}(=+|-+)\s*$/
/** YAML front matter 的界栏。 */
const FRONTMATTER = /^---\s*$/

export interface DocumentTitle {
  text: string
  level: number
}

/**
 * 找第一个标题。找不到返回 `null`。
 *
 * `maxLines` 是防线而不是优化：调用方给进来的可能是一个几十 MB 的文件的开头，
 * 而「标题在前两百行之外」的文档，用文件名标识它反而更诚实。
 */
export function firstHeading(text: string, maxLines = 200): DocumentTitle | null {
  const lines = text.split(/\r?\n/)
  let i = 0

  // YAML front matter 整块跳过。**必须跳**：里面的 `title: x` 不是标题，
  // 而 `---` 收尾栏在下一条规则眼里长得和 Setext 的二级下划线一模一样
  if (lines[0] !== undefined && FRONTMATTER.test(lines[0])) {
    let end = -1
    for (let n = 1; n < lines.length && n <= maxLines; n++) {
      if (FRONTMATTER.test(lines[n] as string)) {
        end = n
        break
      }
    }
    // 没有收尾栏说明用户正敲到一半，或者这压根不是 front matter。
    // 这时**不跳**，照常从头扫 —— 跳掉等于把整篇文档吞了
    if (end > 0) i = end + 1
  }

  let fence: string | null = null

  for (let scanned = 0; i < lines.length && scanned < maxLines; i++, scanned++) {
    const line = lines[i] as string

    // 代码块里的 `#` 是注释或 shell 提示符，不是标题。
    // 只认「同类围栏且不短于开栏」这条闭合规则，跟 CommonMark 一致
    const fenceMark = FENCE.exec(line)?.[1]
    if (fence !== null) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fenceMark) {
      fence = fenceMark
      continue
    }

    const atx = ATX.exec(line)
    if (atx) {
      const body = (atx[2] ?? '').replace(ATX_CLOSING, '').trim()
      // `##` 单独一行是个**空标题**。它是合法的 CommonMark，但拿空字符串当
      // 文件树的标签等于把那一行变成空白，还不如退回文件名
      if (!body) return null
      return { text: body, level: (atx[1] as string).length }
    }

    // Setext：上一行是文字、这一行是 `===` / `---`。
    //
    // 判定要放在 ATX 之后：`---` 也可能是分隔线，而分隔线的前一行若是空行
    // 就不构成标题。这里只认「前一行非空且不是围栏」这一种，
    // 引用块、列表里的 Setext 一律不认 —— 那些位置上的标题不是文档标题
    if (SETEXT.test(line)) {
      const previous = (lines[i - 1] ?? '').trim()
      if (previous && !FENCE.test(previous) && !ATX.test(previous)) {
        return { text: previous, level: (line.trim()[0] === '=' ? 1 : 2) as number }
      }
    }
  }

  return null
}
