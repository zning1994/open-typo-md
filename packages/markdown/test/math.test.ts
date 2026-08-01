/**
 * 数学公式的解析边界。
 *
 * 这一套的重点全在**误伤**上：`$` 在自然语言里首先是货币符号，
 * 一个天真的实现会把 `我花了 $5 买了 $10 的东西` 中间那段渲染成公式。
 * 下面的用例把「什么不是公式」钉得比「什么是公式」还细。
 */
import { describe, expect, it } from 'vitest'
import type { Tree } from '@lezer/common'
import { markdownLanguageSupport } from '../src/index.js'

function parse(doc: string, math = true): Tree {
  return markdownLanguageSupport({ codeLanguages: [], math }).language.parser.parse(doc)
}

/** 文档里被识别成公式的片段。 */
function formulas(doc: string, math = true): string[] {
  const found: string[] = []
  parse(doc, math).iterate({
    enter(node) {
      if (
        node.name === 'InlineMath' ||
        node.name === 'BlockMath' ||
        node.name === 'DisplayMath'
      ) {
        found.push(doc.slice(node.from, node.to))
      }
    },
  })
  return found
}

describe('行内公式', () => {
  it('基本形态', () => {
    expect(formulas('质能方程 $E = mc^2$ 很有名')).toEqual(['$E = mc^2$'])
  })

  it('一行里多个公式', () => {
    expect(formulas('$a$ 与 $b$')).toEqual(['$a$', '$b$'])
  })

  it('反斜杠转义的 $ 不是定界符', () => {
    expect(formulas('价格 \\$5 到 \\$9')).toEqual([])
  })
})

describe('不能被当成公式的东西', () => {
  it('货币金额 —— 闭定界符右边是数字就不算', () => {
    expect(formulas('我花了 $5 买了 $10 的东西')).toEqual([])
  })

  it('开定界符右边紧跟空白', () => {
    expect(formulas('成本 $ 100 元 $ 左右')).toEqual([])
  })

  it('闭定界符左边紧跟空白', () => {
    expect(formulas('$x $ 不是公式')).toEqual([])
  })

  it('空公式', () => {
    expect(formulas('$$$$ 什么都没有')).toEqual([])
  })

  it('公式不跨行', () => {
    expect(formulas('$开头\n结尾$')).toEqual([])
  })

  it('只有一个 $ 时什么都不做', () => {
    expect(formulas('单价 $ 而已')).toEqual([])
  })

  it('行内代码里的 $ 是字面量', () => {
    expect(formulas('`$PATH$HOME`')).toEqual([])
  })

  it('关掉之后一律按普通字符处理', () => {
    expect(formulas('$E = mc^2$', false)).toEqual([])
  })
})

describe('写在一行里的 $$…$$', () => {
  it('是行间公式，块级规则够不着它（那条要求 $$ 独占一行）', () => {
    expect(formulas('公式 $$E = mc^2$$ 在这里')).toEqual(['$$E = mc^2$$'])
  })

  it('定界符两边可以有空格 —— $$ 本身已经不像货币符号了', () => {
    expect(formulas('$$ x + y $$')).toEqual(['$$ x + y $$'])
  })

  it('不跨行；跨行的交给块级规则', () => {
    expect(formulas('$$开头\n结尾$$')).toEqual([])
  })
})

describe('块级公式', () => {
  it('$$ 独占一行时成块', () => {
    const doc = '前文\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n后文'
    expect(formulas(doc)).toEqual(['$$\n\\int_0^1 x\\,dx\n$$'])
  })

  it('内容多行', () => {
    const doc = '$$\na = 1 \\\\\nb = 2\n$$'
    expect(formulas(doc)).toEqual([doc])
  })

  it('没闭合时仍然成块 —— 跟围栏代码块同一个取舍', () => {
    // `$$` 是用户明确打出来的起始标记，此后的内容本来就该按公式对待
    const found = formulas('$$\na = 1')
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('a = 1')
  })

  it('块级公式不会被当成分隔线或其他块结构', () => {
    const names: string[] = []
    parse('$$\nx\n$$').iterate({ enter: (n) => void names.push(n.name) })
    expect(names).not.toContain('HorizontalRule')
    expect(names).toContain('MathContent')
  })

  it('文档里的其他块结构不受影响', () => {
    const names: string[] = []
    parse('# 标题\n\n$$\nx\n$$\n\n- 列表').iterate({ enter: (n) => void names.push(n.name) })
    expect(names).toContain('ATXHeading1')
    expect(names).toContain('BulletList')
    expect(names).toContain('BlockMath')
  })
})
