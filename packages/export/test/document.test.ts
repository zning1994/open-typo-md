/**
 * 单文件文档外壳。
 *
 * 这里最值得钉死的是 **`<html lang>` 默认不写**。写死 `zh-CN` 曾经让 macOS 上
 * 转出来的 PDF 整页一个字都没有 —— 一个看着人畜无害的属性，花了五轮 CI
 * 才定位到（见 06 §3.3）。而且我们本来也不知道用户这篇文档是什么语言。
 */
import { describe, expect, it } from 'vitest'
import { buildDocument } from '@mosu/export'

describe('外壳', () => {
  it('默认不写 lang —— 我们并不知道用户这篇文档是什么语言', () => {
    const html = buildDocument('<p>正文</p>', { title: '文' })
    expect(html).toContain('<html>')
    expect(html).not.toContain('lang=')
  })

  it('给了 lang 才写，且会转义', () => {
    expect(buildDocument('', { title: '文', lang: 'zh-CN' })).toContain('<html lang="zh-CN">')
    expect(buildDocument('', { title: '文', lang: 'a"b' })).toContain('lang="a&quot;b"')
  })

  it('默认带 viewport —— 给人看的 HTML 是一份真网页，会在手机上被打开', () => {
    expect(buildDocument('<p>正文</p>', { title: '文' })).toContain('name="viewport"')
  })

  it('打印用的那一份必须关掉它', () => {
    const html = buildDocument('<p>正文</p>', { title: '文', viewport: false })
    expect(html).not.toContain('viewport')
    // 关掉的只是这一条，别的 meta 照常
    expect(html).toContain('name="generator"')
    expect(html).toContain('charset="utf-8"')
  })

  it('标题被转义 —— 文件名里带尖括号不该把 head 撕开', () => {
    expect(buildDocument('', { title: '<script>x</script>' })).toContain(
      '<title>&lt;script&gt;x&lt;/script&gt;</title>',
    )
  })

  it('正文原样嵌进去，不再转义一遍', () => {
    expect(buildDocument('<h1>标题</h1>', { title: '文' })).toContain('<h1>标题</h1>')
  })

  it('传进来的 CSS 按顺序拼在兜底样式之后', () => {
    const html = buildDocument('', { title: '文', css: [':root{--a:1}', ':root{--b:2}'] })
    expect(html.indexOf('--a')).toBeLessThan(html.indexOf('--b'))
    // 兜底样式必须在最前：没有它，产物是浏览器默认的 Times New Roman 顶到屏幕边
    expect(html.indexOf('font-family')).toBeLessThan(html.indexOf('--a'))
  })
})

/**
 * `<style>` 里的东西不能用 HTML 文本转义器去处理（issue #15）。
 *
 * 原来这两处用的都是 `escapeText`，而它是**文本节点**的转义器。
 * 放进 `<style>` 里两头都不对：`}` `{` `;` 一个都不在它的名单里（拦不住注入），
 * 而 `<style>` 是 raw text 元素、里面**不解码实体**（会破坏本来正确的 CSS）。
 */
describe('样式表这一段', () => {
  /** `<style>` 到它第一个结束标签之间的内容 —— 也就是真正进 CSS 解析器的那部分。 */
  function firstStyleBody(html: string): string {
    const open = html.indexOf('<style>')
    return html.slice(open + '<style>'.length, html.indexOf('</style>', open))
  }

  it('contentWidth 只收 CSS 长度，`42em}body{…` 整条丢掉', () => {
    const html = buildDocument('<p>x</p>', {
      title: 't',
      contentWidth: '42em}body{display:none',
    })
    expect(html).not.toContain('display:none')
    // 兜底样式里有默认宽度，少一条覆盖不会让产物坏掉
    expect(html).toContain('--mosu-content-width: 42em;')
  })

  it('合法的长度照常写进去', () => {
    const html = buildDocument('<p>x</p>', { title: 't', contentWidth: '  60ch  ' })
    expect(html).toContain('--mosu-content-width: 60ch; }')
  })

  it('calc() 也放行 —— 一刀切掉就成了另一种静默丢东西', () => {
    const html = buildDocument('<p>x</p>', { title: 't', contentWidth: 'calc(100% - 2em)' })
    expect(html).toContain('--mosu-content-width: calc(100% - 2em); }')
  })

  it('url() 挡掉', () => {
    const html = buildDocument('<p>x</p>', { title: 't', contentWidth: 'url(http://evil/x)' })
    expect(html).not.toContain('evil')
  })

  it('合法 CSS 不会被实体化 —— <style> 里实体是不解码的，转了就是坏的', () => {
    const html = buildDocument('<p>x</p>', {
      title: 't',
      css: ['.a::after { content: "a & b"; width: calc(100% - 1px); }'],
    })
    expect(firstStyleBody(html)).toContain('content: "a & b"')
    expect(html).not.toContain('&amp;amp;')
  })

  it('css 里的 </style> 闭合不了样式表 —— 主题包可以来自第三方', () => {
    const html = buildDocument('<p>x</p>', {
      title: 't',
      css: ['body::after{content:"</style><img src=x onerror=alert(1)>"}'],
    })
    // 判据是**位置**不是字面量：`<img …>` 这串字符出现在样式表里完全正常
    // （它就是 content 的值），要命的是它出现在样式表**外面**。
    // 所以断言「第一个 </style> 在它后面」—— 提前闭合的话就不是了。
    expect(firstStyleBody(html)).toContain('onerror')
    expect(html.indexOf('onerror')).toBeLessThan(html.indexOf('</style>'))
  })

  it('转义用的是 CSS 的写法，含义不变', () => {
    const html = buildDocument('<p>x</p>', { title: 't', css: ['a{content:"</style>"}'] })
    // CSS 字符串里 \/ 就是 / —— 挡住了标签识别，没改变样式的意思
    expect(firstStyleBody(html)).toContain('<\\/style>')
  })

  it('标题仍然走 HTML 转义 —— 那个位置的规则没变', () => {
    expect(buildDocument('', { title: '<b>&"' })).toContain(
      '<title>&lt;b&gt;&amp;&quot;</title>',
    )
  })
})
