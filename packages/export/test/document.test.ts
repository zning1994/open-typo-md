/**
 * 单文件文档外壳。
 *
 * 这里只有一件事真正值得钉死：**`viewport` meta 必须能关掉**。
 * 带着它去打印，`width=device-width` 会把布局视口绑到打印用的那个隐藏窗口上，
 * 而隐藏窗口的「设备宽度」各平台不一致 —— macOS 上是 0，整份文档被压成零宽，
 * 产出一页纯白。这个缺陷追了四轮 CI（见 06 §3.3），值得留一条测试守着。
 */
import { describe, expect, it } from 'vitest'
import { buildDocument } from '@typo/export'

describe('外壳', () => {
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
