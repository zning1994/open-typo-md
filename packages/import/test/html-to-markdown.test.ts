/**
 * 粘贴 HTML → Markdown。
 *
 * 用例分两类：一类是「转对了」，另一类是「**没有**转坏」。后者才是这条管线的
 * 主要风险 —— 从 Word / Google 文档 / 代码编辑器里粘过来的东西各有各的坏法，
 * 而失败的样子往往不是报错，是悄悄多出几百行 CSS 或者整篇变成粗体。
 */
import { describe, expect, test } from 'vitest'
import { htmlToMarkdown } from '@typo/import'

/** 转换结果，断言用。`null` 表示「不该转，走纯文本」。 */
const md = (html: string): string | null => htmlToMarkdown(html)

describe('基本结构', () => {
  test('标题、强调、链接', () => {
    expect(md('<h1>标题</h1><p>一段<strong>粗</strong>与<em>斜</em></p>')).toBe(
      '# 标题\n\n一段**粗**与*斜*',
    )
    expect(md('<p><a href="https://x.com">链接</a></p>')).toBe('[链接](https://x.com)')
  })

  test('嵌套列表保持层级', () => {
    expect(md('<ul><li>甲</li><li>乙<ul><li>丙</li></ul></li></ul>')).toBe('- 甲\n- 乙\n  - 丙')
  })

  test('任务列表转成 GFM 的复选框', () => {
    expect(
      md(
        '<ul><li><input type="checkbox" checked>做完</li><li><input type="checkbox">没做</li></ul>',
      ),
    ).toBe('- [x] 做完\n- [ ] 没做')
  })

  test('有序列表沿用原始起始序号', () => {
    expect(md('<ol start="3"><li>三</li><li>四</li></ol>')).toBe('3. 三\n4. 四')
  })

  test('表格', () => {
    const html =
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    expect(md(html)).toBe('| A | B |\n| - | - |\n| 1 | 2 |')
  })

  test('代码块保留语言', () => {
    expect(md('<pre><code class="language-js">const a = 1\n</code></pre>')).toBe(
      '```js\nconst a = 1\n```',
    )
  })

  test('行内代码、引用、分隔线、图片', () => {
    expect(md('<p>用 <code>foo()</code> 就行</p>')).toBe('用 `foo()` 就行')
    expect(md('<blockquote><p>引用</p></blockquote>')).toBe('> 引用')
    expect(md('<p>上</p><hr><p>下</p>')).toBe('上\n\n---\n\n下')
    expect(md('<p><img src="a.png" alt="图"></p>')).toBe('![图](a.png)')
  })

  test('br 转成硬换行 —— 纯文本里的 \\n 是软换行，含义不一样', () => {
    expect(md('<p>第一行<br>第二行</p>')).toBe('第一行\\\n第二行')
  })

  test('Markdown 里有特殊含义的字符会被转义', () => {
    // 不转义的话，粘进来的文字会被当成格式指令重新解读
    expect(md('<h2>价格 5 * 3 和 _下划线_</h2>')).toBe('## 价格 5 \\* 3 和 \\_下划线\\_')
  })
})

describe('Google 文档', () => {
  test('假粗体外壳被拆掉 —— 否则整篇都是粗体', () => {
    const html =
      '<b style="font-weight:normal" id="docs-internal-guid-1"><p>正文<span style="font-weight:700">粗</span></p></b>'
    expect(md(html)).toBe('正文**粗**')
  })

  test('靠 id 也能认出来（没写 style 的变体）', () => {
    expect(md('<b id="docs-internal-guid-2"><h1>标题</h1></b>')).toBe('# 标题')
  })

  test('真正的 b 标签不受影响', () => {
    expect(md('<p><b>真粗</b>与<a href="#x">锚</a></p>')).toBe('**真粗**与[锚](#x)')
  })
})

describe('Word', () => {
  test('style 标签的内容不会漏进正文', () => {
    // 最常见也最难看的一种失败：粘一段网页进来多出几百行 CSS
    const out = md('<style>p.Mso{font-size:12pt;color:red}</style><h1>标题</h1>')
    expect(out).toBe('# 标题')
    expect(out).not.toContain('font-size')
  })

  test('script 同理', () => {
    const out = md('<script>alert(1)</script><h1>标题</h1>')
    expect(out).toBe('# 标题')
    expect(out).not.toContain('alert')
  })

  test('o:p 与 mso 类名被丢掉，空段落不留痕', () => {
    const html =
      '<p class="MsoNormal"><span style="font-weight:bold">粗</span><o:p></o:p></p><p>&nbsp;</p><h2>下一节</h2>'
    expect(md(html)).toBe('**粗**\n\n## 下一节')
  })

  test('不断行空格变成普通空格', () => {
    expect(md('<h1>甲\u00a0乙</h1>')).toBe('# 甲 乙')
  })

  test('零宽字符被清掉 —— 它们会破坏 Markdown 的分隔符识别', () => {
    expect(md('<h1>甲\u200b\u200d乙\ufeff</h1>')).toBe('# 甲乙')
  })
})

describe('行内样式还原成语义', () => {
  test('span 上的粗 / 斜 / 删除线', () => {
    expect(md('<h1><span style="font-weight:700">粗</span></h1>')).toBe('# **粗**')
    expect(md('<h1><span style="font-style:italic">斜</span></h1>')).toBe('# *斜*')
    expect(md('<h1><span style="text-decoration:line-through">删</span></h1>')).toBe('# ~~删~~')
  })

  test('s 与 strike 统一成删除线', () => {
    expect(md('<h1><s>甲</s><strike>乙</strike></h1>')).toBe('# ~~甲~~~~乙~~')
  })

  test('整块 div 的粗体**不**提升 —— 那通常是整页样式，照转会得到一整篇粗体', () => {
    expect(md('<div style="font-weight:700"><h1>标题</h1><p>正文</p></div>')).toBe(
      '# 标题\n\n正文',
    )
  })

  test('只有空白的 span 不会变成空的强调标记', () => {
    expect(md('<h1>甲<span style="font-weight:700"> </span>乙</h1>')).toBe('# 甲 乙')
  })
})

describe('不该转的时候不转', () => {
  test('代码编辑器复制过来的带色 div —— 转了只会把代码拆成一堆段落', () => {
    const vscode =
      '<div style="color:#d4d4d4"><div><span style="color:#569cd6">const</span><span> a = 1</span></div></div>'
    expect(md(vscode)).toBeNull()
  })

  test('只有段落的 HTML 跟纯文本没区别，转了反而引入转义', () => {
    expect(md('<p>就是一句话</p><p>第二句</p>')).toBeNull()
    expect(md('<div><div><p>很深的一段</p></div></div>')).toBeNull()
  })

  test('空输入、纯空白、无标签文本', () => {
    expect(md('')).toBeNull()
    expect(md('   \n  ')).toBeNull()
    expect(md('就是一段没有任何标签的文字')).toBeNull()
  })

  test('超大 HTML 退回纯文本 —— 在主线程上啃几 MB 会让界面卡住', () => {
    expect(md(`<h1>${'甲'.repeat(5 * 1024 * 1024)}</h1>`)).toBeNull()
  })

  test('哪怕只有一个链接，也说明有值得转的结构', () => {
    expect(md('<p>看 <a href="https://x.com">这里</a></p>')).toBe('看 [这里](https://x.com)')
  })
})

describe('链接安全', () => {
  test('javascript: 只留文字，不留可点的入口', () => {
    const out = md(
      '<h1><a href="javascript:alert(1)">点我</a>与<a href="https://ok.com">正常</a></h1>',
    )
    expect(out).toBe('# 点我与[正常](https://ok.com)')
    expect(out).not.toContain('javascript')
  })

  test('data: 与 vbscript: 同样拦下', () => {
    expect(md('<h1><a href="data:text/html,<script>1</script>">x</a></h1>')).toBe('# x')
    expect(md('<h1><a href="vbscript:msgbox">x</a></h1>')).toBe('# x')
  })

  test('相对路径与锚点照常放行 —— 它们是正当的链接', () => {
    expect(md('<h1><a href="./b.md">相对</a><a href="#节">锚</a></h1>')).toBe(
      '# [相对](./b.md)[锚](#节)',
    )
  })

  test('图片的 data URI 保留 —— 丢掉就等于丢内容', () => {
    expect(md('<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="小图"></p>')).toBe(
      '![小图](data:image/png;base64,iVBORw0KGgo=)',
    )
  })

  test('空链接是纯噪声，直接丢', () => {
    expect(md('<h1>甲<a href="https://x.com"></a>乙</h1>')).toBe('# 甲乙')
  })
})

describe('降级而不是丢内容', () => {
  test('合并单元格摊平，文字一个不少', () => {
    const out = md(
      '<table><tr><th colspan="2">跨两列</th></tr><tr><td>1</td><td>2</td></tr></table>',
    )
    expect(out).toContain('跨两列')
    expect(out).toContain('1')
    expect(out).toContain('2')
  })

  test('嵌套表格摊平，文字一个不少', () => {
    const out = md('<table><tr><td><table><tr><td>内</td></tr></table></td></tr></table>')
    expect(out).toContain('内')
  })

  test('单元格里的块级内容被压平（GFM 表达不了），但不丢字', () => {
    const out = md('<table><tr><td><p>一段</p><p>又一段</p></td><td>乙</td></tr></table>')
    expect(out).toContain('一段')
    expect(out).toContain('又一段')
  })

  test('残缺的 HTML 不抛错', () => {
    expect(() => md('<ul><li>甲<li>乙')).not.toThrow()
    expect(md('<ul><li>甲<li>乙')).toBe('- 甲\n- 乙')
    expect(() => md('<h1>没闭合')).not.toThrow()
    expect(() => md('<<<>>>&&&')).not.toThrow()
  })

  test('整份文档（带 html/head/body）也能处理', () => {
    const full =
      '<!doctype html><html><head><meta charset="utf-8"><title>页</title><style>a{}</style></head><body><h1>标题</h1></body></html>'
    expect(md(full)).toBe('# 标题')
  })

  test('注释（含 Word 的条件注释）不会变成正文', () => {
    expect(md('<!--[if gte mso 9]><xml>junk</xml><![endif]--><h1>标题</h1>')).toBe('# 标题')
  })
})
