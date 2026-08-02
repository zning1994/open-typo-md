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
 * 按 class 整棵丢掉的东西 —— **一份显式名单，不是前缀匹配**。
 *
 * 原来写的是 `c.startsWith('mso')`，两头都不对（issue #16d）：
 *
 * - **误伤**：Word 用 `class=msoIns` 标记修订里**插入的正文**，
 *   `msoDel` 标记删除的。前缀一刀切把插入的字整段销毁了 ——
 *   而那是用户真正想粘过来的内容。
 * - **没生效**：注释里说的意图（挡住 Word 的正文标记）从来没实现过。
 *   Word 实际的类名是 `MsoNormal` / `MsoListParagraph`，大写 `M`，
 *   `startsWith('mso')` 恒为 false。
 *
 * 所以改成写死几个确实该丢的，大小写不敏感比较。`msoIns` **刻意不在里面**。
 */
const DROPPED_CLASSES = new Set([
  // 批注锚点与批注正文：它们不是文档正文，粘过来只会变成夹在句子中间的碎片
  'msocommentreference',
  'msocommenttext',
  // 修订里被删掉的文字。它在原文档里就是「已经删了」的状态，
  // 粘过来会让读者以为那些字还在
  'msodel',
])

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
 * 这段行内样式里，属性 `name` 的值匹不匹配 `value`。
 *
 * 关键在于**锚到声明的开头**（`^` 或 `;`）。不锚的话，任何以这个名字结尾的
 * 厂商私有属性都会命中 —— `mso-bidi-font-weight:normal` 会被当成
 * `font-weight:normal`，于是（issue #16b）：
 *
 * - `<b style="mso-bidi-font-weight:normal">重点</b>` 的加粗被剥掉；
 * - `<span style="mso-bidi-font-weight:bold">普通</span>` 凭空变粗；
 * - 更糟的是 `mso-bidi-font-weight:normal;font-weight:bold` —— 真正的
 *   `font-weight:bold` 被前面那个厂商后缀盖掉，整段加粗丢失。
 *
 * `-webkit-font-weight`、`mso-bidi-font-style` 之类同理。
 */
function declares(style: string, name: string, value: RegExp): boolean {
  return new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*${value.source}`, 'i').test(style)
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
  if (declares(style, 'text-decoration', /[^;]*\bline-through\b/)) out = [element('del', out)]
  if (declares(style, 'font-style', /italic\b/)) out = [element('em', out)]
  if (declares(style, 'font-weight', /(?:bold(?:er)?|[6-9]00)\b/))
    out = [element('strong', out)]
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
  return declares(styleOf(node), 'font-weight', /(?:normal|[1-5]00)\b/)
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
  if (classesOf(node).some((c) => DROPPED_CLASSES.has(c.toLowerCase()))) return []

  const children = cleanChildren(node.children)

  // `b` 归一成 `strong`、`i` 归一成 `em`、`s`/`strike` 归一成 `del`：
  // 下游只认一种写法，`normalizeEmphasis` 才能把相邻的合并起来。
  // Markdown 里这几对本来也只有一种表示，归一是无损的。
  if (name === 'b' || name === 'strong') {
    return isFakeBold(node) ? children : [element('strong', children)]
  }
  if (name === 'i' || name === 'em') return [element('em', children)]
  if (name === 'span' || name === 'font') return promoteStyledSpan(node, children)
  if (UNWRAPPED.has(name)) return children

  if (name === 's' || name === 'strike') return [element('del', children)]

  if (name === 'a') {
    const href = node.properties?.['href']
    // 空链接（`[](url)`）纯属噪声；协议不安全的链接只留文字，不留可点的入口
    if (isBlank(children)) return []
    if (typeof href !== 'string' || !isSafeHref(href)) return children
  }

  // `<caption>` 是表格标题，而 mdast 的表格序列化器**不认识它** ——
  // 挺过 clean 阶段之后会在转换时被静默丢掉（issue #16c）。
  // 它在维基百科、Google 文档和各种 CMS 的表格里都很常见，
  // 而用户看不见自己丢了什么，也找不回来。
  //
  // 提到表格**前面**变成一个段落：这是唯一无损的去处。塞在表格里面等于没做，
  // 塞进第一个单元格会改变表格的形状。`figcaption` 一直是保留的，
  // 同样的意图对 `caption` 漏了。
  if (name === 'table') {
    const caption: RootContent[] = []
    const rest: RootContent[] = []
    for (const child of children) {
      if (isElement(child) && child.tagName === 'caption') caption.push(...child.children)
      else rest.push(child)
    }
    if (isBlank(rest)) return []
    const table = { ...node, children: rest } as Element
    return isBlank(caption) ? [table] : [element('p', caption), table]
  }

  if (DROP_IF_BLANK.has(name) && isBlank(children)) return []

  return [{ ...node, children } as Element]
}

/** 会被「挤空白 + 合并相邻」处理的包裹层。 */
const EMPHASIS = new Set(['strong', 'em', 'del'])

function isElement(node: RootContent | undefined): node is Element {
  return node?.type === 'element'
}

/**
 * 把一串子节点首尾的空白拆出来。
 *
 * 只看两端**紧邻的文本节点**，不深入元素内部 —— `<b><i> x</i></b>` 这种
 * 空白藏在内层的写法，挤出来会改变结构，得不偿失。
 */
function splitEdges(children: readonly RootContent[]): {
  lead: string
  core: RootContent[]
  tail: string
} {
  const core = [...children]
  let lead = ''
  let tail = ''

  while (core.length > 0) {
    const first = core[0]
    if (first?.type !== 'text') break
    const match = /^\s+/.exec(first.value)
    if (!match) break
    lead += match[0]
    const rest = first.value.slice(match[0].length)
    if (rest === '') core.shift()
    else {
      core[0] = { ...first, value: rest }
      break
    }
  }

  while (core.length > 0) {
    const last = core[core.length - 1]
    if (last?.type !== 'text') break
    const match = /\s+$/.exec(last.value)
    if (!match) break
    tail = match[0] + tail
    const rest = last.value.slice(0, last.value.length - match[0].length)
    if (rest === '') core.pop()
    else {
      core[core.length - 1] = { ...last, value: rest }
      break
    }
  }

  return { lead, core, tail }
}

/**
 * 强调节点的归一化（issue #16a）。
 *
 * 两条规则，缺一条都会产出**字面星号**：
 *
 * 1. **首尾空白挤到包裹层外面。** CommonMark 的 flanking 规则不允许标记贴着
 *    空白，所以 `<b>Hello </b>` 序列化出的 `**Hello **` 在**后面紧跟另一个
 *    标记**时会失效；
 * 2. **相邻的同类包裹层合并。** `<b>Hel</b><b>lo</b>` 序列化出
 *    `**Hel****lo**`，中间那四个星号会被解析成一个空的强调，
 *    渲染成 `<strong>Hel****lo</strong>`。
 *
 * 这两种形状都不是罕见构造：把一句话的一半重新加粗一次，
 * 富文本编辑器就会切成两个相邻节点。用户粘过来的是一句加粗的话，
 * 得到的是正文里可见的星号加上一半丢了加粗。
 *
 * 顺带丢掉空的（或只剩空白的）包裹层：`<h1>甲<b></b>乙</h1>` 会产出
 * `# 甲****乙`，那四个星号同样是凭空多出来的。
 */
function normalizeEmphasis(children: readonly RootContent[]): RootContent[] {
  const lifted: RootContent[] = []
  for (const child of children) {
    if (!isElement(child) || !EMPHASIS.has(child.tagName)) {
      lifted.push(child)
      continue
    }
    const { lead, core, tail } = splitEdges(child.children)
    if (lead !== '') lifted.push({ type: 'text', value: lead })
    // 挤完之后什么都不剩 —— 这个包裹层本来就没有内容可强调
    if (core.length > 0 && !isBlank(core)) {
      lifted.push({ ...child, children: core } as Element)
    }
    if (tail !== '') lifted.push({ type: 'text', value: tail })
  }

  const merged: RootContent[] = []
  for (const child of lifted) {
    const prev = merged[merged.length - 1]
    if (
      isElement(child) &&
      isElement(prev) &&
      EMPHASIS.has(child.tagName) &&
      prev.tagName === child.tagName
    ) {
      merged[merged.length - 1] = {
        ...prev,
        children: [...prev.children, ...child.children],
      } as Element
      continue
    }
    merged.push(child)
  }
  return merged
}

function cleanChildren(children: readonly RootContent[]): RootContent[] {
  const out: RootContent[] = []
  for (const child of children) out.push(...cleanNode(child))
  return normalizeEmphasis(out)
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
