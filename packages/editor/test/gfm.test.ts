/**
 * GFM 与 M2 补齐的语法在实时预览下的呈现。
 *
 * 断言的是「用户看到什么」，不是装饰对象的结构 —— 后者换个实现就得重写一遍，
 * 前者才是产品行为本身。
 */
import { describe, expect, it } from 'vitest'
import { classesAt, lineClasses, mkState, preview } from './helpers.js'

describe('表格', () => {
  const TABLE = ['| 姓名 | 年龄 |', '| --- | ---: |', '| 张三 | 30 |', '| 李四 | 4 |'].join(
    '\n',
  )

  it('分隔行藏起来，竖线也藏起来', () => {
    expect(preview(TABLE)).toBe([' 姓名  年龄 ', ' 张三  30 ', ' 李四  4 '].join('\n'))
  })

  it('每一行都是表格行', () => {
    const state = mkState(TABLE, { selection: 0 })
    expect(lineClasses(state, 1)).toContain('cm-typo-tr')
    expect(lineClasses(state, 1)).toContain('cm-typo-tr-head')
    expect(lineClasses(state, 3)).toContain('cm-typo-tr')
    expect(lineClasses(state, 3)).not.toContain('cm-typo-tr-head')
  })

  it('单元格范围包含它左边那根竖线 —— 显形时列结构才不会变', () => {
    // 见 tables.ts 的说明：竖线若落在两个 table-cell 之间，
    // 浏览器会给它生成一个匿名单元格，列数凭空多出来
    const state = mkState(TABLE, { selection: 0 })
    const rowStart = state.doc.line(3).from
    expect(state.doc.sliceString(rowStart, rowStart + 1)).toBe('|')
    expect(classesAt(state, rowStart)).toContain('cm-typo-td')
  })

  it('对齐方式从分隔行读出来', () => {
    const state = mkState(TABLE, { selection: 0 })
    const secondCell = state.doc.line(3).from + 7 // 第二格里的某个字符
    expect(classesAt(state, secondCell)).toContain('cm-typo-td-right')
  })

  it('居中与左对齐', () => {
    const doc = '| a | b | c |\n| :- | :-: | -: |\n| 1 | 2 | 3 |'
    const state = mkState(doc, { selection: 0 })
    const row = state.doc.line(3)
    expect(classesAt(state, row.from + 2)).toContain('cm-typo-td-left')
    expect(classesAt(state, row.from + 6)).toContain('cm-typo-td-center')
    expect(classesAt(state, row.from + 10)).toContain('cm-typo-td-right')
  })

  it('光标进入表格时整张表的竖线一起显形', () => {
    // 逐行显形会让那一行脱出匿名表格盒，一张表劈成两张、列宽分家
    const rendered = preview(TABLE, { selection: TABLE.indexOf('张三') })
    expect(rendered).toBe(TABLE)
  })

  it('光标在表格外面时不显形', () => {
    const doc = `${TABLE}\n\n后面的段落`
    expect(preview(doc, { selection: doc.length })).not.toContain('---')
  })

  it('没有前导竖线的表格也能切对', () => {
    expect(preview('a | b\n--- | ---\n1 | 2')).toBe('a  b\n1  2')
  })

  it('转义的竖线是内容，不是分界', () => {
    // 表头整行只有一格；`\|` 既不藏、也不切分（反斜杠被转义规则藏掉）
    expect(preview('| a \\| b |\n| --- |\n| c |')).toBe(' a | b \n c ')
  })

  it('单元格里的行内格式照常渲染', () => {
    expect(preview('| a |\n| --- |\n| **粗** |')).toBe(' a \n 粗 ')
  })

  it('各行单元格数量不一致也不会崩', () => {
    expect(() => preview('| a | b |\n| --- | --- |\n| 只有一格 |')).not.toThrow()
  })

  it('表格后面紧跟普通段落时，段落不会被卷进来', () => {
    const doc = '| a |\n| --- |\n| b |\n\n普通段落'
    expect(preview(doc)).toBe(' a \n b \n\n普通段落')
  })
})

describe('任务列表', () => {
  it('[ ] 与 [x] 换成复选框', () => {
    expect(preview('- [ ] 待办\n- [x] 已完成')).toBe('• ☐ 待办\n• ☑ 已完成')
  })

  it('大写的 [X] 同样识别为已完成', () => {
    expect(preview('- [X] 完成')).toBe('• ☑ 完成')
  })

  it('光标在本行时露出源码，方便手改', () => {
    expect(preview('- [ ] 待办', { selection: 8 })).toBe('- [ ] 待办')
  })

  it('不在列表里的 [ ] 不是任务标记', () => {
    expect(preview('这里有个 [ ] 方括号')).toBe('这里有个 [ ] 方括号')
  })
})

describe('删除线', () => {
  it('~~x~~ 藏掉标记', () => {
    expect(preview('~~删除线~~')).toBe('删除线')
  })

  it('光标进入时显形', () => {
    expect(preview('~~删除线~~', { selection: 3 })).toBe('~~删除线~~')
  })

  it('带上删除线的样式类', () => {
    expect(classesAt(mkState('~~删除线~~', { selection: 0 }), 3)).toContain('cm-typo-strike')
  })
})

describe('自动链接', () => {
  it.each(['www.example.com', 'https://example.com/a?b=1', 'someone@example.com'])(
    '%s 标成链接',
    (url) => {
      const state = mkState(`前面 ${url} 后面`, { selection: 0 })
      expect(classesAt(state, 4)).toContain('cm-typo-autolink')
    },
  )

  it('一个字符都不藏 —— 自动链接的源码本身就是要显示的内容', () => {
    expect(preview('访问 www.example.com 看看')).toBe('访问 www.example.com 看看')
  })

  it('行内链接的 URL 不会被重复标记', () => {
    // `[文字](url)` 里的 URL 已经被 handleLink 折叠掉了
    expect(preview('[文字](http://x.io)')).toBe('文字')
  })
})

describe('脚注', () => {
  it('引用 [^1] 只留标签，做成上标', () => {
    expect(preview('正文[^1]。')).toBe('正文1。')
    expect(classesAt(mkState('正文[^1]。', { selection: 0 }), 4)).toContain(
      'cm-typo-footnote-ref',
    )
  })

  it('光标进入引用时显形', () => {
    expect(preview('正文[^1]。', { selection: 3 })).toBe('正文[^1]。')
  })

  it('定义行整行保留 —— 标签是内容（第几条），不是纯标记', () => {
    expect(preview('[^1]: 脚注内容')).toBe('[^1]: 脚注内容')
    expect(lineClasses(mkState('[^1]: 脚注内容', { selection: 0 }), 1)).toContain(
      'cm-typo-footnote-def',
    )
  })

  it('认不出来的写法原样保留，不吞内容', () => {
    expect(preview('[^]空标签')).toBe('[^]空标签')
  })
})

describe('转义与实体', () => {
  it('\\* 藏掉反斜杠', () => {
    expect(preview('a \\* b')).toBe('a * b')
  })

  it('光标贴在转义字符上时显形', () => {
    expect(preview('a \\* b', { selection: 3 })).toBe('a \\* b')
  })

  it('转义按闭区间显形，不是整行 —— 否则整段文字会左右横跳', () => {
    // 光标停在同一行的行尾，离转义字符很远：转义仍应保持隐藏
    const doc = 'a \\* b 后面还有很长一段'
    expect(preview(doc, { selection: doc.length })).toBe('a * b 后面还有很长一段')
  })

  it.each([
    ['&amp;', '&'],
    ['&lt;', '<'],
    ['&nbsp;', ' '],
    ['&mdash;', '—'],
    ['&#65;', 'A'],
    ['&#x4e2d;', '中'],
  ])('%s 解码成 %s', (entity, decoded) => {
    expect(preview(`前${entity}后`)).toBe(`前${decoded}后`)
  })

  it('认不出来的实体原样显示', () => {
    expect(preview('前&notarealentity;后')).toBe('前&notarealentity;后')
  })

  it('代理对区间等非法码点不解码', () => {
    expect(preview('&#xD800;')).toBe('&#xD800;')
  })

  it('光标进入实体时显示源码', () => {
    expect(preview('前&amp;后', { selection: 2 })).toBe('前&amp;后')
  })
})

describe('严格 CommonMark 方言下 GFM 全部退化为纯文本', () => {
  it.each(['| a | b |\n| - | - |', '- [ ] 待办', '~~删除线~~', '正文[^1]。'])('%s', (doc) => {
    expect(preview(doc, { dialect: 'commonmark' })).toBe(
      // 任务列表在 CommonMark 下只是普通列表，圆点仍然生效
      doc.startsWith('- ') ? doc.replace(/^- /, '• ') : doc,
    )
  })
})

describe('YAML front matter', () => {
  const DOC = '---\ntitle: 我的文章\ntags: [笔记]\n---\n\n# 正文标题\n\n段落'

  it('元数据一个字都不藏', () => {
    // 它是内容，用户要能看见和改 —— 跟有序列表编号同一条理由。
    //
    // 必须显式给光标位置：preview() 默认会在文档前面垫一段「停车位」文本，
    // 而 front matter 只认文档最开头，垫了就不成立了。
    // 正文里的 `# ` 该藏还是藏，所以只比对元数据那几行。
    const rendered = preview(DOC, { selection: DOC.length })
    expect(rendered.split('\n\n')[0]).toBe('---\ntitle: 我的文章\ntags: [笔记]\n---')
  })

  it('元数据的每一行都带上样式', () => {
    const state = mkState(DOC, { selection: DOC.length })
    for (const line of [1, 2, 3, 4]) {
      expect(lineClasses(state, line)).toContain('cm-typo-frontmatter')
    }
  })

  it('正文不带元数据样式', () => {
    const state = mkState(DOC, { selection: DOC.length })
    expect(lineClasses(state, 6)).not.toContain('cm-typo-frontmatter')
    expect(lineClasses(state, 6)).toContain('cm-typo-heading')
  })

  it('文档中间的 --- 仍然是分隔线', () => {
    expect(preview('段落\n\n---\n\n后面')).toBe('段落\n\n─\n\n后面')
  })
})

describe('数学公式', () => {
  it('行内公式换成渲染结果', () => {
    expect(preview('质能方程 $E = mc^2$ 很有名')).toBe('质能方程 ⟦math:E = mc^2⟧ 很有名')
  })

  it('光标进入行内公式时还原成源码', () => {
    const doc = '质能方程 $E = mc^2$ 很有名'
    expect(preview(doc, { selection: 8 })).toBe(doc)
  })

  it('货币金额不会被当成公式', () => {
    expect(preview('我花了 $5 买了 $10 的东西')).toBe('我花了 $5 买了 $10 的东西')
  })

  it('块级公式整块换掉', () => {
    const doc = '前文\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n后文'
    expect(preview(doc)).toBe('前文\n\n⟦math:\\int_0^1 x\\,dx⟧\n\n后文')
  })

  it('光标进入块级公式时整块还原', () => {
    const doc = '前文\n\n$$\nx = 1\n$$\n\n后文'
    expect(preview(doc, { selection: doc.indexOf('x = 1') })).toBe(doc)
  })

  it('只有开围栏、没有内容时不渲染，留着源码让用户改', () => {
    const doc = '前文\n\n$$'
    expect(preview(doc)).toBe(doc)
  })

  it('一行里的 $$…$$ 按行间公式渲染', () => {
    expect(preview('公式 $$E = mc^2$$ 在这里')).toBe('公式 ⟦math:E = mc^2⟧ 在这里')
  })

  it('关掉数学扩展后一律按普通字符处理', () => {
    expect(preview('$E = mc^2$', { math: false })).toBe('$E = mc^2$')
  })
})
