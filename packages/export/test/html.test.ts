/**
 * Markdown → HTML 导出。
 *
 * 重点在两处：**消毒**（导出产物是要发给别人的，漏一条就是别人机器上的一次
 * XSS）和**降级**（宿主能力没注入时不能把内容弄丢）。
 */
import { describe, expect, it } from 'vitest'
import { buildDocument, markdownToHtmlFragment } from '../src/index.js'

describe('基本转换', () => {
  it('标题、强调、列表', async () => {
    const html = await markdownToHtmlFragment('# 标题\n\n**粗**与*斜*\n\n- 甲\n- 乙')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<strong>粗</strong>')
    expect(html).toContain('<em>斜</em>')
    expect(html).toContain('<li>甲</li>')
  })

  it('GFM：表格、任务列表、删除线、脚注', async () => {
    const html = await markdownToHtmlFragment(
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [x] 完成\n\n~~删除~~\n\n正文[^1]\n\n[^1]: 注解',
    )
    expect(html).toContain('<table>')
    expect(html).toContain('<del>删除</del>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('footnote')
  })

  it('代码块带语言类名，主题据此上色', async () => {
    const html = await markdownToHtmlFragment('```js\nconst a = 1\n```')
    expect(html).toContain('language-js')
    expect(html).toContain('const a = 1')
  })

  it('数学公式渲染成 KaTeX', async () => {
    const html = await markdownToHtmlFragment('行内 $E = mc^2$ 与\n\n$$\n\\int_0^1 x\n$$')
    expect(html).toContain('katex')
  })

  it('写错的公式不抛异常，原文还在', async () => {
    // rehype-katex 自己就做了降级：严格模式失败后以宽松模式重渲染
    const html = await markdownToHtmlFragment('$\\frac{1}$')
    expect(html).toContain('katex')
    expect(html.length).toBeGreaterThan(0)
  })

  it('front matter 默认丢弃 —— 它是元数据不是正文', async () => {
    const html = await markdownToHtmlFragment('---\ntitle: 标题\n---\n\n正文')
    expect(html).not.toContain('title: 标题')
    expect(html).toContain('正文')
  })

  it('显式要求时才导出 front matter', async () => {
    const html = await markdownToHtmlFragment('---\ntitle: 标题\n---\n\n正文', {
      keepFrontmatter: true,
    })
    expect(html).toContain('title: 标题')
  })
})

/**
 * 「没有活的 X」跟「字符串里没有 X 这几个字母」不是一回事。
 *
 * 修 issue #1 之前白名单外的 HTML 是被**整段删掉**的，于是 `not.toContain('onerror')`
 * 恰好通过 —— 但它通过的理由是「内容丢了」，不是「内容安全了」。现在这些标签
 * 转义成可见文本，`onerror` 这几个字母当然还在，那正是用户写下的东西。
 *
 * 所以断言要盯住真正的性质：**它不是标记**。
 * 判据是那对尖括号有没有被转义掉 —— 转义了就进不了解析器。
 */
function assertInert(html: string, ...literals: string[]): void {
  // 一个未转义的 `<` 后面跟字母，就意味着这里有一个活的标签
  expect(html.replace(/<\/?[a-z][^>]*>/gi, '')).not.toMatch(/<[a-zA-Z]/)
  for (const literal of literals) expect(html).toContain(literal)
}

describe('消毒', () => {
  it('script 默认被清掉', async () => {
    const html = await markdownToHtmlFragment('<script>alert(1)</script>\n\n正文')
    expect(html).not.toContain('<script')
    // 内容仍然看得见，只是成了字面文本（issue #1）
    assertInert(html, 'alert(1)')
  })

  it('事件属性进不了标记', async () => {
    const html = await markdownToHtmlFragment('<img src=x onerror="alert(1)">')
    // 没有 <img 元素被创建出来
    expect(html).not.toMatch(/<img\b/)
    assertInert(html, 'onerror')
  })

  it('javascript: 协议的链接被清掉', async () => {
    const html = await markdownToHtmlFragment('[点我](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('iframe 被清掉', async () => {
    const html = await markdownToHtmlFragment('<iframe src="http://evil"></iframe>')
    expect(html).not.toContain('<iframe')
    assertInert(html)
  })

  it('style 属性不放行 —— 它能塞进 url(...) 之类的东西', async () => {
    const html = await markdownToHtmlFragment('<p style="background:url(x)">正文</p>')
    // 带属性的标签根本不在白名单里，整段按字面显示
    expect(html).not.toMatch(/<p style=/)
    assertInert(html, 'background:url(x)')
  })

  it('class 放行，主题靠它上色', async () => {
    const html = await markdownToHtmlFragment('```js\nx\n```')
    expect(html).toContain('class=')
  })

  it('显式打开开关才保留原始 HTML', async () => {
    const html = await markdownToHtmlFragment('<div class="x">原始</div>', {
      allowRawHtml: true,
    })
    expect(html).toContain('<div class="x">')
  })
})

describe('宿主能力注入', () => {
  it('注入之后 mermaid 块变成内联 SVG', async () => {
    const html = await markdownToHtmlFragment('```mermaid\ngraph TD\nA-->B\n```', {
      renderDiagram: async (code) => `<svg data-code="${code.trim().length}"></svg>`,
    })
    expect(html).toContain('<svg')
    expect(html).toContain('mosu-diagram')
    expect(html).not.toContain('language-mermaid')
  })

  it('没注入时按代码块导出 —— 图没了但源码还在', async () => {
    const html = await markdownToHtmlFragment('```mermaid\ngraph TD\nA-->B\n```')
    expect(html).toContain('language-mermaid')
    expect(html).toContain('graph TD')
  })

  it('渲染失败（返回 null）也保留代码块', async () => {
    const html = await markdownToHtmlFragment('```mermaid\n乱写\n```', {
      renderDiagram: async () => null,
    })
    expect(html).toContain('乱写')
  })

  it('图片转 data URI', async () => {
    const html = await markdownToHtmlFragment('![图](assets/a.png)', {
      inlineImage: async () => 'data:image/png;base64,AAA',
    })
    expect(html).toContain('data:image/png;base64,AAA')
  })

  it('没注入时保留原路径 —— 产物不自包含，但引用是对的', async () => {
    const html = await markdownToHtmlFragment('![图](assets/a.png)')
    expect(html).toContain('assets/a.png')
  })

  it('注入的 SVG 不会被消毒裁碎 —— 它是我们自己生成的', async () => {
    const html = await markdownToHtmlFragment('```mermaid\nx\n```', {
      renderDiagram: async () => '<svg><path d="M0 0"/><text>标签</text></svg>',
    })
    expect(html).toContain('<path')
    expect(html).toContain('标签')
  })
})

describe('自包含单文件', () => {
  it('包成完整文档，标题被转义', async () => {
    const doc = buildDocument('<p>正文</p>', { title: '我的<文档>' })
    expect(doc).toContain('<!doctype html>')
    expect(doc).toContain('我的&lt;文档&gt;')
    expect(doc).toContain('<p>正文</p>')
  })

  it('正文不会被二次转义', async () => {
    const fragment = await markdownToHtmlFragment('**粗体**')
    const doc = buildDocument(fragment, { title: 't' })
    expect(doc).toContain('<strong>粗体</strong>')
    expect(doc).not.toContain('&lt;strong&gt;')
  })

  it('自带兜底排版 —— 没有它导出的文件像是导坏了', () => {
    const doc = buildDocument('<p>x</p>', { title: 't' })
    expect(doc).toContain('max-width: var(--mosu-content-width)')
  })

  it('传入的主题 CSS 排在兜底之后，能覆盖它', () => {
    const doc = buildDocument('<p>x</p>', { title: 't', css: ['body { color: red; }'] })
    expect(doc.indexOf('body { color: red; }')).toBeGreaterThan(doc.indexOf('max-width'))
  })

  it('没有外链资源 —— 自包含的定义就是这个', () => {
    const doc = buildDocument('<p>x</p>', { title: 't', css: ['a{}'] })
    expect(doc).not.toContain('<link ')
    expect(doc).not.toContain('<script ')
  })
})

/**
 * 行内 HTML（issue #1）。
 *
 * 修之前这条路上什么都没有：`remarkRehype` 把原始 HTML 变成 `raw` 节点，
 * 而 `rehypeStringify` 在 `allowDangerousHtml: false` 下直接把它们丢掉。
 * 于是 `H<sub>2</sub>O` 导出成 `H2O` —— 不是掉了样式，是**内容的意思变了**。
 *
 * 这一组的判据统一是「跟编辑器一致」：白名单里的渲染成真元素，
 * 其余的转义成可见文本。白名单是同一份（`@mosu/markdown`），
 * 所以这条一致性是结构性的，不靠两边各自小心。
 */
describe('行内 HTML', () => {
  it('白名单内的标签渲染成对应元素 —— 上下标丢了就是内容错了', async () => {
    const html = await markdownToHtmlFragment('H<sub>2</sub>O 与 x<sup>2</sup>')
    expect(html).toContain('H<sub>2</sub>O')
    expect(html).toContain('x<sup>2</sup>')
  })

  it('b / strong / i / em / kbd / mark 都认', async () => {
    const html = await markdownToHtmlFragment(
      '<b>b</b> <strong>s</strong> <i>i</i> <em>e</em> <kbd>K</kbd> <mark>m</mark>',
    )
    for (const tag of ['b', 'strong', 'i', 'em', 'kbd', 'mark']) {
      expect(html).toMatch(new RegExp(`<${tag}>`))
    }
  })

  it('del / ins 归到 s / u —— 跟编辑器渲染成同一个样子', async () => {
    const html = await markdownToHtmlFragment('<del>d</del> 与 <ins>i</ins>')
    expect(html).toContain('<s>d</s>')
    expect(html).toContain('<u>i</u>')
  })

  it('<br> 真的换行，不是被吃掉', async () => {
    const html = await markdownToHtmlFragment('上<br>下')
    expect(html).toContain('上<br>下')
  })

  it('带属性的标签一律不认，按字面显示 —— 属性是注入面的载体', async () => {
    const html = await markdownToHtmlFragment('<b class="x">正文</b>')
    expect(html).not.toMatch(/<b class/)
    // 引号在文本节点里不需要转义，尖括号才是分界 —— 所以断言盯尖括号
    expect(html).toContain('&#x3C;b class="x">')
    expect(html).toContain('正文')
    assertInert(html)
  })

  it('块级 HTML 转义成可见文本，而不是被删掉', async () => {
    // 一篇讨论 HTML 本身的技术文章，导出后代码示例不该凭空消失
    const html = await markdownToHtmlFragment('<div>block</div>')
    expect(html).not.toMatch(/<div\b/)
    expect(html).toContain('block')
    assertInert(html, 'div')
  })

  it('没闭合的标签按字面显示，不猜用户想干什么', async () => {
    const html = await markdownToHtmlFragment('Unclosed: <b>never closed')
    expect(html).not.toMatch(/<b>/)
    expect(html).toContain('never closed')
  })

  it('落单的闭标签同样不静默丢弃', async () => {
    const html = await markdownToHtmlFragment('文字 </b> 更多')
    expect(html).toContain('文字')
    expect(html).toContain('更多')
    assertInert(html, 'b')
  })

  it('交叉嵌套只渲染确定的那部分，被跨过的标签按字面显示', async () => {
    // `<b><i>x</b>` —— 与其猜，不如只认 <b>
    const html = await markdownToHtmlFragment('<b><i>x</b>')
    expect(html).toContain('<b>')
    expect(html).not.toMatch(/<i>/)
  })

  it('开关打开时才放行原始 HTML，此时不做这套转换', async () => {
    const html = await markdownToHtmlFragment('<div class="x">原始</div>', {
      allowRawHtml: true,
    })
    expect(html).toContain('<div class="x">')
  })
})

/**
 * 脚注锚点（issue #11）。
 *
 * `mdast-util-to-hast` 已经用 `user-content-` 处理过 `id` 和 `href`，
 * 而消毒器的 clobber 列表里**没有 href** —— 于是 id 被加了第二次前缀、
 * href 没有，导出文件里每一个脚注跳转都指向不存在的锚点。
 *
 * 原来的用例是 `expect(html).toContain('footnote')`，怎么样都能过。
 */
describe('脚注锚点', () => {
  /** 所有 `href="#..."` 都得能在文档里找到同名的 id。 */
  function dangling(html: string): string[] {
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1] as string))
    return [...html.matchAll(/href="#([^"]+)"/g)]
      .map((m) => m[1] as string)
      .filter((target) => !ids.has(target))
  }

  it('跳转与返回链接都指得到 —— 消毒开着的时候', async () => {
    const html = await markdownToHtmlFragment('Text with a note[^1].\n\n[^1]: The note body.\n')
    expect(dangling(html)).toEqual([])
  })

  it('前缀只加一次，不是 user-content-user-content-', async () => {
    const html = await markdownToHtmlFragment('note[^1]\n\n[^1]: body\n')
    expect(html).not.toContain('user-content-user-content-')
  })

  it('消毒关掉时同样指得到 —— 两条路给出一致的结果', async () => {
    const html = await markdownToHtmlFragment('note[^1]\n\n[^1]: body\n', {
      allowRawHtml: true,
    })
    expect(dangling(html)).toEqual([])
  })

  it('多个脚注互不串位', async () => {
    const html = await markdownToHtmlFragment('a[^1] b[^2]\n\n[^1]: 一\n[^2]: 二\n')
    expect(dangling(html)).toEqual([])
  })
})

/**
 * 图片的 src（issues #12、#13）。
 */
describe('图片的 src', () => {
  it('data: 图片原样保留 —— 它本来就是我们想产出的形态', async () => {
    const html = await markdownToHtmlFragment('![logo](data:image/svg+xml;base64,PHN2Zy8+)', {
      inlineImage: async () => null,
    })
    expect(html).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"')
  })

  it('file: 图片也保留 —— 删掉 src 只剩一个没有源的坏 img，比留着更糟', async () => {
    const html = await markdownToHtmlFragment('![shot](file:///home/u/a.png)', {
      inlineImage: async () => null,
    })
    expect(html).toContain('src="file:///home/u/a.png"')
  })

  it('http 图片照旧', async () => {
    const html = await markdownToHtmlFragment('![x](https://example.com/a.png)', {
      inlineImage: async () => null,
    })
    expect(html).toContain('src="https://example.com/a.png"')
  })

  it('传给宿主的是用户写下的文件名，不是百分号编码后的', async () => {
    // 编码过的话宿主会去找一个字面量叫 `%E5%9B%BE%E7%89%87.png` 的文件，
    // 永远找不到 —— 「自包含」对所有非 ASCII 文件名都不成立
    const seen: string[] = []
    await markdownToHtmlFragment('![a](图片.png)\n\n![b](<my image.png>)', {
      inlineImage: async (src) => {
        seen.push(src)
        return null
      },
    })
    expect(seen).toEqual(['图片.png', 'my image.png'])
  })

  it('解不动的百分号原样交出去，不因为解码失败就丢掉这张图', async () => {
    // `50%.png` 里那个落单的 % 会让 decodeURIComponent 抛
    const seen: string[] = []
    await markdownToHtmlFragment('![a](50%.png)', {
      inlineImage: async (src) => {
        seen.push(src)
        return null
      },
    })
    expect(seen).toEqual(['50%.png'])
  })
})

/**
 * 「复制为富文本」的片段（issue #14）。
 */
describe('富文本片段', () => {
  it('公式只剩一份表示 —— 三份叠在一起是内容错了，不是样式问题', async () => {
    const html = await markdownToHtmlFragment('公式：$E = mc^2$ 完', { forFragment: true })
    const visible = html.replace(/<[^>]*>/g, '')
    // 修之前这里是 `公式：E=mc2E = mc^2E=mc2 完`
    expect(visible).not.toContain('mc^2')
    expect(visible.match(/E/g) ?? []).toHaveLength(1)
  })

  it('留的是 MathML —— 支持的目标渲染成公式，不支持的退化成一份文本', async () => {
    const html = await markdownToHtmlFragment('$x^2$', { forFragment: true })
    expect(html).toContain('<math')
    expect(html).not.toContain('katex-html')
    expect(html).not.toContain('annotation')
  })

  it('关键排版摊成 style 属性 —— 目标应用不会带上我们的 CSS', async () => {
    const html = await markdownToHtmlFragment('> 引用\n\n`行内`\n\n| a |\n| --- |\n| 1 |\n', {
      forFragment: true,
    })
    expect(html).toMatch(/<blockquote style="[^"]*border-left/)
    expect(html).toMatch(/<code style="[^"]*background/)
    expect(html).toMatch(/<td style="[^"]*border/)
  })

  it('用的是字面值不是 var() —— 目标文档里没有我们的 :root', async () => {
    const html = await markdownToHtmlFragment('> 引用', { forFragment: true })
    const styles = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1] as string)
    expect(styles.length).toBeGreaterThan(0)
    for (const style of styles) expect(style).not.toContain('var(')
  })

  it('代码块里的 code 不套第二层底色', async () => {
    const html = await markdownToHtmlFragment('```js\nx\n```', { forFragment: true })
    const code = /<code[^>]*style="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(code).not.toContain('background')
  })

  it('不开这个开关时一个 style 属性都不加 —— 文档那条路靠 <head> 里的 CSS', async () => {
    const html = await markdownToHtmlFragment('> 引用\n\n`行内`')
    expect(html).not.toContain('style=')
  })
})
