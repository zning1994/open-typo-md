/**
 * 脚注扩展的解析行为。
 *
 * 这里断言的是**语法树形状**而不是渲染结果 —— 脚注是自己写的解析器，
 * 出问题一定出在树上；呈现规则的测试在 @typo/editor 那边。
 */
import { describe, expect, it } from 'vitest'
import type { SyntaxNode, Tree } from '@lezer/common'
import { markdownLanguageSupport } from '../src/index.js'

function parse(doc: string): Tree {
  return markdownLanguageSupport({ codeLanguages: [] }).language.parser.parse(doc)
}

/**
 * 把树压成 `名字[原文]` 的嵌套字符串，断言起来一眼能看懂。
 *
 * `Document` / `Body` 这些结构性包装节点跳过，缩进按**第一个被输出的节点**
 * 归零 —— 否则加一层外层语言（比如 YAML front matter）就会让所有断言
 * 集体偏移两个空格，而树本身其实一点没变。
 */
const WRAPPERS = new Set(['Document', 'Body'])

function shape(doc: string): string {
  const parts: string[] = []
  let base = -1
  parse(doc).iterate({
    enter(node) {
      if (WRAPPERS.has(node.name)) return
      let depth = 0
      for (let n: SyntaxNode | null = node.node.parent; n; n = n.parent) depth++
      if (base < 0) base = depth
      parts.push(
        `${'  '.repeat(Math.max(0, depth - base))}${node.name}[${doc.slice(node.from, node.to)}]`,
      )
    },
  })
  return parts.join('\n')
}

describe('脚注引用', () => {
  it('正文里的 [^1] 解析成 FootnoteRef', () => {
    expect(shape('文字[^1]。')).toBe(
      [
        'Paragraph[文字[^1]。]',
        '  FootnoteRef[[^1]]',
        '    FootnoteMark[[^]',
        '    FootnoteLabel[1]',
        '    FootnoteMark[]]',
      ].join('\n'),
    )
  })

  it('标签可以是中文、可以带标点', () => {
    expect(shape('a[^注-1]b')).toContain('FootnoteLabel[注-1]')
  })

  it('空标签 [^] 不是脚注，按普通文本留着', () => {
    expect(shape('a[^]b')).not.toContain('FootnoteRef')
  })

  it('标签里有空格就不是脚注 —— 退化成普通链接语法，不吞内容', () => {
    const out = shape('a[^a b]c')
    expect(out).not.toContain('FootnoteRef')
    expect(out).toContain('Link')
  })

  it('抢在 Link 前面：[^1] 不会被当成链接', () => {
    expect(shape('文字[^1]。')).not.toContain('Link[')
  })

  it('普通链接不受影响', () => {
    expect(shape('[文字](http://x.io)')).toContain('Link[[文字](http://x.io)]')
  })
})

describe('脚注定义', () => {
  it('[^1]: 内容 解析成 Footnote 而不是 LinkReference', () => {
    expect(shape('[^1]: 脚注内容')).toBe(
      [
        'Footnote[[^1]: 脚注内容]',
        '  FootnoteMark[[^]',
        '  FootnoteLabel[1]',
        '  FootnoteMark[]:]',
      ].join('\n'),
    )
  })

  it('定义里的行内格式照常解析', () => {
    expect(shape('[^1]: 有*强调*的内容')).toContain('Emphasis[*强调*]')
  })

  it('连续多条定义各自独立 —— 不会被惰性延续粘成一条', () => {
    const out = shape('[^a]: 甲\n[^b]: 乙\n')
    expect(out).toContain('Footnote[[^a]: 甲]')
    expect(out).toContain('Footnote[[^b]: 乙]')
  })

  it('定义内容可以换行接着写（惰性延续）', () => {
    expect(shape('[^1]: 第一行\n继续写第二行\n')).toContain(
      'Footnote[[^1]: 第一行\n继续写第二行]',
    )
  })

  it('空行终止定义，后面是普通段落', () => {
    const out = shape('[^1]: 内容\n\n普通段落\n')
    expect(out).toContain('Footnote[[^1]: 内容]')
    expect(out).toContain('Paragraph[普通段落]')
  })

  it('普通的链接引用定义仍然是 LinkReference', () => {
    expect(shape('[ref]: http://x.io')).toContain('LinkReference')
  })

  it('段落中间出现的定义行会打断段落', () => {
    const out = shape('段落文字\n[^1]: 定义\n')
    expect(out).toContain('Paragraph[段落文字]')
    expect(out).toContain('Footnote[[^1]: 定义]')
  })
})

describe('commonmark 方言下脚注不生效', () => {
  it('退化为普通文本，绝不吞内容', () => {
    const doc = '文字[^1]。'
    const tree = markdownLanguageSupport({
      dialect: 'commonmark',
      codeLanguages: [],
    }).language.parser.parse(doc)
    let found = false
    tree.iterate({
      enter(node) {
        if (node.name.startsWith('Footnote')) found = true
      },
    })
    expect(found).toBe(false)
  })
})

describe('已知取舍', () => {
  /**
   * 见 FootnoteDefinitionParser.nextLine 的说明：为了不被 LinkReference 抢走，
   * 定义块会截断排在后面的叶子解析器，Setext 与表格因此对它失效。
   * 这条测试把这个副作用钉住 —— 它是有意的，不是回归。
   */
  it('以 [^x]: 开头的块不会再变成 Setext 标题', () => {
    const out = shape('[^1]: 内容\n===\n')
    expect(out).toContain('Footnote[')
    expect(out).not.toContain('SetextHeading')
  })
})
