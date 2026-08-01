/**
 * 实时预览的行为测试。
 *
 * 这些断言就是产品定义本身：「用户看到什么、什么时候看到源码」。
 * 任何一条挂了，都说明手感变了 —— 不要顺手改断言，先想清楚是不是回归。
 */
import { describe, expect, it } from 'vitest'
import { classesAt, hiddenRanges, lineClasses, mkState, preview } from './helpers.js'

describe('行内强调', () => {
  it('平时隐藏标记', () => {
    expect(preview('这是 **粗体** 内容')).toBe('这是 粗体 内容')
    expect(preview('这是 *斜体* 内容')).toBe('这是 斜体 内容')
    expect(preview('这是 `代码` 内容')).toBe('这是 代码 内容')
  })

  it('光标进入时标记就地显形', () => {
    // "这是 **粗体** 内容" —— 光标放在「粗」字上
    expect(preview('这是 **粗体** 内容', { selection: 6 })).toBe('这是 **粗体** 内容')
  })

  it('光标停在标记右侧紧邻位置也要显形', () => {
    // 这是闭区间规则的意义：否则用户没法在加粗内容的结尾继续输入
    const doc = '这是 **粗体** 内容'
    const endOfStrong = doc.indexOf('**粗体**') + '**粗体**'.length
    expect(preview(doc, { selection: endOfStrong })).toBe(doc)
  })

  it('光标在同一行但不在该元素内则不显形', () => {
    // 行内元素按闭区间算，不按行算 —— 否则一行里有五处强调会一起炸开
    const doc = '这是 **粗体** 内容'
    expect(preview(doc, { selection: doc.length })).toBe('这是 粗体 内容')
  })

  it('加粗文字带上样式类', () => {
    const state = mkState('这是 **粗体** 内容')
    expect(classesAt(state, 5)).toContain('cm-typo-strong')
  })

  it('嵌套强调各自独立判定', () => {
    expect(preview('**粗 *斜* 体**')).toBe('粗 斜 体')
  })
})

describe('标题', () => {
  it('隐藏 # 与其后的空格', () => {
    expect(preview('# 一级标题')).toBe('一级标题')
    expect(preview('### 三级标题')).toBe('三级标题')
  })

  it('光标在该行时显形（按行判定，避免文字横跳）', () => {
    expect(preview('# 一级标题', { selection: 4 })).toBe('# 一级标题')
  })

  it('给整行打上层级类，供主题控制字号', () => {
    const state = mkState('## 二级')
    expect(lineClasses(state, 1)).toEqual(
      expect.arrayContaining(['cm-typo-heading', 'cm-typo-h2']),
    )
  })

  it('闭合式标题的收尾 # 也一并隐藏', () => {
    expect(preview('# 标题 #')).toBe('标题')
  })

  it('Setext 标题的下划线不隐藏（隐藏会留下一个空行，观感更糟）', () => {
    expect(preview('标题\n===')).toBe('标题\n===')
  })
})

describe('引用与列表', () => {
  it('隐藏引用标记，改由行装饰画左边线', () => {
    expect(preview('> 引用内容')).toBe('引用内容')
    expect(lineClasses(mkState('> 引用内容'), 1)).toContain('cm-typo-quote')
  })

  it('嵌套引用逐层隐藏', () => {
    expect(preview('>> 两层')).toBe('两层')
  })

  it('无序列表标记显示为圆点，源码字符不变', () => {
    expect(preview('- 项目')).toBe('• 项目')
    expect(preview('* 项目')).toBe('• 项目')
    expect(preview('+ 项目')).toBe('• 项目')
  })

  it('有序列表的编号保留可见（编号是内容的一部分）', () => {
    expect(preview('1. 项目')).toBe('1. 项目')
  })

  it('光标进入列表行时还原原始标记字符', () => {
    expect(preview('- 项目', { selection: 3 })).toBe('- 项目')
  })
})

describe('链接与图片', () => {
  it('行内链接只显示文字', () => {
    expect(preview('见 [文档](https://example.com) 了解详情')).toBe('见 文档 了解详情')
  })

  it('光标进入链接时展开完整源码', () => {
    const doc = '见 [文档](https://example.com) 了解'
    expect(preview(doc, { selection: 5 })).toBe(doc)
  })

  it('引用式链接同样折叠', () => {
    expect(preview('见 [文档][doc] 了解')).toBe('见 文档 了解')
  })

  it('自动链接折叠尖括号', () => {
    expect(preview('见 <https://example.com> 了解')).toBe('见 https://example.com 了解')
  })

  it('图片替换为 widget，路径经 AssetResolver 解析', () => {
    expect(
      preview('![截图](shot.png)', {
        assetResolver: (src) => `typo-asset://workspace/${src}`,
      }),
    ).toBe('⟦img:typo-asset://workspace/shot.png|截图⟧')
  })

  it('拿不到 URL 的图片退回显示源码，不吞内容', () => {
    // 引用式图片没有 URL 子节点 —— 宁可显示源码，也不能变成一个空白
    expect(preview('![截图][ref]')).toBe('![截图][ref]')
  })

  it('光标进入图片时显示源码', () => {
    expect(preview('![截图](shot.png)', { selection: 3 })).toBe('![截图](shot.png)')
  })
})

describe('代码', () => {
  it('行内装饰层不碰围栏 —— 藏 ``` 是块级装饰层的事', () => {
    // preview() 只跑 computeDecorations（ViewPlugin 那条路）。围栏的隐藏靠
    // blocks.ts 的 StateField，两条路在 CodeMirror 里是分开的：
    // 会改变行结构的装饰不允许由 ViewPlugin 提供。
    // 围栏实际隐藏与显形的行为由 e2e/live-preview.spec.ts 覆盖。
    const doc = '```js\nconst a = 1\n```'
    expect(preview(doc)).toBe(doc)
    expect(lineClasses(mkState(doc), 2)).toContain('cm-typo-code-block')
  })

  it('代码块里的 ** 不会被当成加粗', () => {
    const doc = '```\n**不是粗体**\n```'
    expect(preview(doc)).toBe(doc)
  })

  it('行内代码里的标记同样不解析', () => {
    expect(preview('`**字面量**`')).toBe('**字面量**')
  })
})

describe('分隔线', () => {
  it('整行替换为分隔线 widget', () => {
    expect(preview('上\n\n---\n\n下')).toBe('上\n\n─\n\n下')
  })

  it('光标在该行时还原源码', () => {
    expect(preview('上\n\n---\n\n下', { selection: 4 })).toBe('上\n\n---\n\n下')
  })
})

describe('选区行为', () => {
  it('全选不会把整篇文档炸成源码', () => {
    // 用选区端点判定而不是整个跨度 —— 见 active.ts 里的理由
    const doc = '# 标题\n\n**粗体**段落\n\n> 引用'
    const rendered = preview(doc, { selection: [[0, doc.length]] })
    expect(rendered).not.toContain('**')
    expect(rendered).toContain('粗体')
  })

  it('多光标各自独立显形', () => {
    const doc = '**一** 和 **二**'
    const rendered = preview(doc, { selection: [2, doc.length - 2] })
    expect(rendered).toBe(doc)
  })
})

describe('结构不变量', () => {
  it('隐藏区间互不重叠', () => {
    // 重叠的 replace 装饰会让 CodeMirror 直接抛错，属于必炸型 bug
    const doc = '# 标题 **粗** [链接](url) ![图](i.png)\n\n> - 项目 `代码`'
    const ranges = hiddenRanges(mkState(doc))
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]![0]).toBeGreaterThanOrEqual(ranges[i - 1]![1])
    }
  })

  it('隐藏区间不跨越换行（跨行的 replace 不允许由 ViewPlugin 提供）', () => {
    const doc = '# 标题\n\n> 引用\n\n- 项目\n\n---'
    const state = mkState(doc)
    for (const [from, to] of hiddenRanges(state)) {
      expect(state.doc.sliceString(from, to)).not.toContain('\n')
    }
  })

  it('样式类不进 atomic 集合（否则光标会跳过整段加粗文字）', () => {
    const state = mkState('这是 **粗体** 内容')
    const hidden = hiddenRanges(state)
    // 只该藏两处 `**`，各 2 个字符
    expect(hidden.map(([f, t]) => t - f)).toEqual([2, 2])
  })
})

describe('未知语法原样保留', () => {
  it.each([
    ':::note\n提示\n:::',
    '$$x^2$$',
    '| a | b |\n| - | - |',
    '<div class="x">原始 HTML</div>',
    '[[Wiki 链接]]',
    '~~删除线~~', // CommonMark 方言下不是语法，M2 开 GFM 后才是
  ])('%s', (doc) => {
    expect(preview(doc)).toBe(doc)
  })
})
