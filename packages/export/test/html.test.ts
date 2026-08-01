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

describe('消毒', () => {
  it('script 默认被清掉', async () => {
    const html = await markdownToHtmlFragment('<script>alert(1)</script>\n\n正文')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('事件属性被清掉', async () => {
    const html = await markdownToHtmlFragment('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('onerror')
  })

  it('javascript: 协议的链接被清掉', async () => {
    const html = await markdownToHtmlFragment('[点我](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('iframe 被清掉', async () => {
    const html = await markdownToHtmlFragment('<iframe src="http://evil"></iframe>')
    expect(html).not.toContain('<iframe')
  })

  it('style 属性不放行 —— 它能塞进 url(...) 之类的东西', async () => {
    const html = await markdownToHtmlFragment('<p style="background:url(x)">正文</p>')
    expect(html).not.toContain('style=')
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
    expect(html).toContain('typo-diagram')
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
    expect(doc).toContain('max-width: var(--typo-content-width)')
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
