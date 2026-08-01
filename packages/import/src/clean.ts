/**
 * 粘贴进来的 HTML 的预处理（docs/design/03 §8）。
 *
 * 真实剪贴板里的 HTML 跟教科书里的 HTML 不是一个东西。Word 会塞 `mso-` 私有
 * 属性和 `<o:p>`；Google 文档把**整篇**内容包进一个
 * `<b style="font-weight:normal">`；网页里到处是布局用的 `<div>` 和
 * 只为了排版存在的空段落。直接扔给 hast → mdast 的话，得到的是一份
 * 满是 `**` 的、夹着大段 CSS 文本的垃圾。
 *
 * 所以先在 hast 这一层把噪声清掉，再交给转换。规则都是**针对具体来源**的 ——
 * 与其写一套「通用清洗」然后到处都不太对，不如为每个已知的坏来源写一条
 * 说得清楚的规则。
 */
import type { Element, Root, RootContent } from 'hast'

/**
 * 整个丢掉的元素。
 *
 * `style` 和 `script` 必须在这儿丢：它们的**文本内容**会被当成正文，
 * 粘一段网页进来会多出几百行 CSS。这是最常见也最难看的一种失败。
 */
const DROPPED = new Set([
  'script',
  'style',
  'noscript',
  'head',
  'title',
  'meta',
  'link',
  'base',
  'template',
  'object',
  'embed',
  'iframe',
  'canvas',
  'svg',
  'button',
  'select',
  'textarea',
  // Word 的私有命名空间元素
  'o:p',
  'v:shape',
  'v:imagedata',
  'w:sdt',
])

/** 这些元素不带语义，一律拆掉外壳保留内容。 */
const UNWRAPPED = new Set([
  'span',
  'font',
  'html',
  'body',
  'article',
  'section',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'figure',
  'figcaption',
  'u',
  'mark',
  'small',
  'abbr',
  'time',
  'bdi',
  'bdo',
  'ruby',
  'label',
])

/** 空内容时可以整个丢掉的块级容器。行内元素不在此列 —— 丢了会吃掉词间空格。 */
const DROP_IF_BLANK = new Set([
  'p',
  'div',
  'li',
  'ul',
  'ol',
  'table',
  'thead',
  'tbody',
  'tr',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
])

/** 即使不含文字也必须保留的元素。 */
const MEANINGFUL_WHEN_EMPTY = new Set(['img', 'br', 'hr', 'input', 'td', 'th'])

/**
 * 「转换之后确实多了点东西」的判据。
 *
 * 刻意**不包含 `p` 和 `div`**：只有段落的 HTML 转出来跟 `text/plain` 没区别，
 * 而走转换反而会引入转义。见 `hasSemantics` 的说明。
 */
const SEMANTIC = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'a',
  'strong',
  'b',
  'em',
  'i',
  'code',
  'pre',
  'blockquote',
  'img',
  'del',
  's',
  'hr',
  'br',
  'input',
  'dl',
  'dt',
  'dd',
])

/**
 * 链接协议的白名单。没有协议（相对路径、`#锚点`）一律放行。
 *
 * 白名单而不是黑名单：粘贴进来的链接会**留在用户的文档里**，之后可能被点开、
 * 被导出、被分享。`javascript:` 只是最出名的那一个，黑名单永远列不全。
 * 被拦下的链接只丢掉可点的入口，文字照留 —— 内容一个字不少（原则 P2）。
 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'ftp', 'ftps'])
const SCHEME = /^([a-z][a-z\d+.-]*):/i

function isSafeHref(href: string): boolean {
  const match = SCHEME.exec(href.trim())
  return match === null || SAFE_SCHEMES.has(match[1]!.toLowerCase())
}

function styleOf(node: Element): string {
  const value = node.properties?.['style']
  return typeof value === 'string' ? value : ''
}

function classesOf(node: Element): string[] {
  const value = node.properties?.['className']
  return Array.isArray(value) ? value.map(String) : []
}

/**
 * 文本层面的归一化。
 *
 * 不断行空格（U+00A0）在网页里几乎都是排版副产物，留着的话 Markdown 源码里
 * 会有一个看不见、又搜不到的字符 —— 用户只会觉得「这里怎么删不掉」。
 * 零宽字符同理，而且它们还会破坏 Markdown 的分隔符识别。
 */
function normalizeText(value: string): string {
  // 写成转义序列而不是字面量：这几个字符在编辑器里看不见，
  // 字面量形式的正则等于盲改
  return value.replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '')
}

/** 只有空白、且不含图片 / 换行这类「空着也算数」的元素。 */
function isBlank(children: readonly RootContent[]): boolean {
  for (const child of children) {
    if (child.type === 'text') {
      if (child.value.trim() !== '') return false
    } else if (child.type === 'element') {
      if (MEANINGFUL_WHEN_EMPTY.has(child.tagName)) return false
      if (!isBlank(child.children)) return false
    } else {
      return false
    }
  }
  return true
}

function element(tagName: string, children: RootContent[]): Element {
  return { type: 'element', tagName, properties: {}, children: children as Element['children'] }
}

/**
 * 把行内样式还原成语义标签。
 *
 * Word 与 Google 文档表达粗体的方式是 `<span style="font-weight:700">`，
 * 而不是 `<b>`。不做这一步的话，从这两个地方粘过来的东西会**完全丢掉格式**
 * —— 这恰恰是用户最常抱怨的一种粘贴。
 *
 * 只认 `span` / `font`：整块 `div` 被设成粗体通常是标题样式或整页样式，
 * 照着转会得到一整篇加粗的文档。
 */
function promoteStyledSpan(node: Element, children: RootContent[]): RootContent[] {
  const style = styleOf(node)
  if (!style || isBlank(children)) return children

  let out = children
  if (/text-decoration[^;]*\bline-through\b/i.test(style)) out = [element('del', out)]
  if (/font-style\s*:\s*italic\b/i.test(style)) out = [element('em', out)]
  if (/font-weight\s*:\s*(?:bold(?:er)?|[6-9]00)\b/i.test(style)) out = [element('strong', out)]
  return out
}

/**
 * Google 文档的假粗体外壳。
 *
 * 它把整篇内容包进 `<b style="font-weight:normal" id="docs-internal-guid-…">`。
 * 不拆掉的话，从 Google 文档粘过来的**每一个字**都会变成粗体 ——
 * 这是这类转换里最出名的一个坑。
 */
function isFakeBold(node: Element): boolean {
  const id = node.properties?.['id']
  if (typeof id === 'string' && id.startsWith('docs-internal-guid')) return true
  return /font-weight\s*:\s*(?:normal|[1-5]00)\b/i.test(styleOf(node))
}

function cleanNode(node: RootContent): RootContent[] {
  if (node.type === 'comment' || node.type === 'doctype') return []
  if (node.type === 'text') {
    const value = normalizeText(node.value)
    return value === '' ? [] : [{ ...node, value }]
  }
  if (node.type !== 'element') return [node]

  const name = node.tagName.toLowerCase()
  if (DROPPED.has(name)) return []
  // Word 用 class 而不是标签标记那些不该出现在正文里的东西
  if (classesOf(node).some((c) => c.startsWith('mso') || c === 'MsoCommentReference')) return []

  const children = cleanChildren(node.children)

  if (name === 'b' || name === 'strong') {
    return isFakeBold(node) ? children : [{ ...node, tagName: name, children } as Element]
  }
  if (name === 'span' || name === 'font') return promoteStyledSpan(node, children)
  if (UNWRAPPED.has(name)) return children

  // s / strike 统一成 del，让下游只认一种删除线
  if (name === 's' || name === 'strike') return [element('del', children)]

  if (name === 'a') {
    const href = node.properties?.['href']
    // 空链接（`[](url)`）纯属噪声；协议不安全的链接只留文字，不留可点的入口
    if (isBlank(children)) return []
    if (typeof href !== 'string' || !isSafeHref(href)) return children
  }

  if (DROP_IF_BLANK.has(name) && isBlank(children)) return []

  return [{ ...node, children } as Element]
}

function cleanChildren(children: readonly RootContent[]): RootContent[] {
  const out: RootContent[] = []
  for (const child of children) out.push(...cleanNode(child))
  return out
}

/** 清洗整棵树。返回新树，不改原树。 */
export function cleanTree(tree: Root): Root {
  return { ...tree, children: cleanChildren(tree.children) }
}

/**
 * 这段 HTML 里有没有 Markdown 表达得了的结构。
 *
 * 没有的话就**不该转**。典型来源是代码编辑器：从 VS Code 复制一段代码，
 * 剪贴板里的 `text/html` 是一堆带行内配色的 `<div><span>`，
 * 转出来是若干个互不相干的段落 —— 而 `text/plain` 里躺着的正是原封不动的代码。
 *
 * 判据只看结构，不看内容：既然转换换不来任何结构，那它带来的就只有转义和风险。
 */
export function hasSemantics(tree: Root): boolean {
  let found = false
  const walk = (children: readonly RootContent[]): void => {
    for (const child of children) {
      if (found) return
      if (child.type !== 'element') continue
      if (SEMANTIC.has(child.tagName)) {
        found = true
        return
      }
      walk(child.children)
    }
  }
  walk(tree.children)
  return found
}
