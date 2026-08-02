/**
 * 行内 HTML 的渲染（路线图 M4.5 #6）。
 *
 * 这个文件里**一半以上的用例断言的是「不渲染」**，那不是保守，那就是这个功能
 * 的定义：能渲染的是一个封闭集合，集合之外的一切按原文显示。安全模型的完整
 * 说明见 src/live-preview/inline-html.ts 开头。
 */
import { describe, expect, it } from 'vitest'
import { classesAt, hiddenRanges, mkState, preview } from './helpers.js'

describe('认得的标签', () => {
  it('成对标签平时藏起来，只留内容', () => {
    expect(preview('这是 <b>粗体</b> 内容')).toBe('这是 粗体 内容')
    expect(preview('这是 <em>斜体</em> 内容')).toBe('这是 斜体 内容')
    expect(preview('按 <kbd>Esc</kbd> 退出')).toBe('按 Esc 退出')
    expect(preview('H<sub>2</sub>O 与 E=mc<sup>2</sup>')).toBe('H2O 与 E=mc2')
  })

  it('内容带上对应的样式类', () => {
    const state = mkState('前文 <b>粗体</b> 后文', { selection: 0 })
    const at = state.doc.toString().indexOf('粗体')
    expect(classesAt(state, at)).toContain('cm-mosu-html-b')
    expect(classesAt(state, at)).toContain('cm-mosu-html')
  })

  it('同义标签共用一个类 —— del 就是 s，ins 就是 u', () => {
    const state = mkState('前文 <del>删掉</del> 后文', { selection: 0 })
    expect(classesAt(state, state.doc.toString().indexOf('删掉'))).toContain('cm-mosu-html-s')
  })

  it('光标进去就露出标签本身', () => {
    const doc = '这是 <b>粗体</b> 内容'
    expect(preview(doc, { selection: doc.indexOf('粗体') })).toBe(doc)
  })

  it('光标在同一行但不在这个元素里，不显形', () => {
    const doc = '这是 <b>粗体</b> 内容'
    expect(preview(doc, { selection: doc.length })).toBe('这是 粗体 内容')
  })

  it('嵌套的成对标签各自成立', () => {
    expect(preview('<em><strong>双</strong></em>')).toBe('双')
    const state = mkState('前文 <em><strong>双</strong></em>', { selection: 0 })
    const classes = classesAt(state, state.doc.toString().indexOf('双'))
    expect(classes).toContain('cm-mosu-html-em')
    expect(classes).toContain('cm-mosu-html-strong')
  })

  it('跨行的一对也能配上 —— 段落是一个整体，不是一行', () => {
    expect(preview('跨 <b>行\n继续</b> 了')).toBe('跨 行\n继续 了')
  })

  it('`<br>` 换成一个真的换行 widget', () => {
    expect(preview('上<br>下')).toBe('上⏎下')
    // 光标贴上去仍然要能看见源码，否则删不掉它
    expect(preview('上<br>下', { selection: 2 })).toBe('上<br>下')
  })

  it('大小写不敏感', () => {
    expect(preview('这是 <B>粗体</B> 内容')).toBe('这是 粗体 内容')
    expect(preview('上<BR>下')).toBe('上⏎下')
  })

  it('隐藏区间互不重叠 —— 重叠的 replace 装饰会让 CodeMirror 当场抛错', () => {
    // 光标停在前导段落上，让后面那一段保持「平时的样子」
    const state = mkState('光标停在这里\n\n<em><strong>双</strong></em> 与 <b>粗</b> 和 <br>', {
      selection: 0,
    })
    const ranges = hiddenRanges(state)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]![0]).toBeGreaterThanOrEqual(ranges[i - 1]![1])
    }
  })
})

describe('不认得的一律原样显示（原则 P2）', () => {
  it('带属性的标签不渲染 —— 属性是绝大多数注入面的载体', () => {
    expect(preview('这是 <b class="x">粗体</b> 内容')).toBe('这是 <b class="x">粗体</b> 内容')
    expect(preview('<b style="color:red">红</b>')).toBe('<b style="color:red">红</b>')
  })

  it('白名单之外的标签不渲染', () => {
    expect(preview('<span>普通</span>')).toBe('<span>普通</span>')
    expect(preview('<a href="http://x">链</a>')).toBe('<a href="http://x">链</a>')
    expect(preview('<img src="x.png">')).toBe('<img src="x.png">')
  })

  it('危险标签一个字都不动', () => {
    const evil = '<script>alert(1)</script>'
    expect(preview(evil)).toBe(evil)
    const handler = '<b onclick="alert(1)">点</b>'
    expect(preview(handler)).toBe(handler)
    const iframe = '<iframe src="http://evil"></iframe>'
    expect(preview(iframe)).toBe(iframe)
  })

  it('没闭合的开标签不渲染', () => {
    expect(preview('未闭 <b>合')).toBe('未闭 <b>合')
  })

  it('孤零零的闭标签不渲染', () => {
    expect(preview('孤 </b> 儿')).toBe('孤 </b> 儿')
  })

  it('交叉嵌套只认能确定的那一层', () => {
    // `<b><i>x</b>` —— `<i>` 作废，`<b>` 成对
    expect(preview('<b><i>交叉</b>')).toBe('<i>交叉')
  })

  it('把非空元素写成自闭合的不渲染 —— 各家浏览器的处理并不一致', () => {
    expect(preview('<b/>空')).toBe('<b/>空')
  })

  it('`</br>` 不是合法写法', () => {
    expect(preview('上</br>下')).toBe('上</br>下')
  })

  it('不认得的标签夹在中间，不影响外层配对', () => {
    expect(preview('<b>粗 <span x>里</span> 体</b>')).toBe('粗 <span x>里</span> 体')
  })

  it('块级 HTML 整块原样显示', () => {
    const block = '<div>\n块内容\n</div>'
    expect(preview(block)).toBe(block)
  })

  it('代码块里的标签是代码，不是 HTML', () => {
    expect(preview('`<b>字面</b>`')).toBe('<b>字面</b>')
    // 围栏本身被块级装饰藏起来了（那是代码块自己的规矩），但里面一个字没动
    expect(preview('```\n<b>字面</b>\n```')).toBe('<b>字面</b>')
  })
})

describe('开关关掉之后', () => {
  it('全部退回原文显示', () => {
    expect(preview('这是 <b>粗体</b> 内容', { renderInlineHtml: false })).toBe(
      '这是 <b>粗体</b> 内容',
    )
    expect(preview('上<br>下', { renderInlineHtml: false })).toBe('上<br>下')
  })

  it('Markdown 自己的语法不受影响', () => {
    expect(preview('**粗** 与 <b>粗</b>', { renderInlineHtml: false })).toBe('粗 与 <b>粗</b>')
  })
})

describe('跟 Markdown 结构共存', () => {
  it('标题里的行内 HTML 照样渲染', () => {
    expect(preview('# 标 <b>题</b>')).toBe('标 题')
  })

  it('表格单元格里的行内 HTML 照样渲染', () => {
    const doc = '| 甲 | 乙 |\n| --- | --- |\n| <b>粗</b> | 普通 |'
    expect(preview(doc)).toContain('粗')
    expect(preview(doc)).not.toContain('<b>')
  })

  it('Markdown 强调与 HTML 标签用不同的类 —— 源码里写的是哪一种必须分得出来', () => {
    const md = mkState('前文 **粗**', { selection: 0 })
    const html = mkState('前文 <b>粗</b>', { selection: 0 })
    expect(classesAt(md, md.doc.toString().indexOf('粗'))).toContain('cm-mosu-strong')
    expect(classesAt(html, html.doc.toString().indexOf('粗'))).toContain('cm-mosu-html-b')
  })
})
