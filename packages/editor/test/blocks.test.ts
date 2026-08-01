/**
 * 块级装饰（围栏代码块的隐藏）。
 *
 * 跟 live-preview.test.ts 分开测，因为它们走的是 CodeMirror 里两条不同的路：
 * 行内装饰由 ViewPlugin 提供，会改变行结构的块级装饰必须由 StateField 提供。
 */
import { describe, expect, it } from 'vitest'
import { computeBlockDecorations } from '@typo/editor'
import { mkState } from './helpers.js'

/** 被块级装饰盖住的区间及其原文。 */
function hidden(doc: string, selection?: number): Array<[number, number, string]> {
  const state = mkState(doc, selection === undefined ? {} : { selection })
  const set = computeBlockDecorations(state)
  const out: Array<[number, number, string]> = []
  const iter = set.iter()
  while (iter.value) {
    if ((iter.value.spec as { block?: boolean }).block) {
      out.push([iter.from, iter.to, state.doc.sliceString(iter.from, iter.to)])
    }
    iter.next()
  }
  return out
}

const BLOCK = '前文\n\n```js\nconst a = 1\n```\n\n后文'

describe('围栏代码块', () => {
  it('光标在块外时，开闭围栏都被盖住', () => {
    const covered = hidden(BLOCK, BLOCK.length).map(([, , text]) => text)
    expect(covered.join('|')).toContain('```js')
    expect(covered.join('|')).toContain('```')
  })

  it('盖住的范围一律往前吃换行，不往后', () => {
    // 往后吃会让围栏行和下一行合并，下一行的行装饰锚点落进被替换区间里
    // 而被整个丢弃 —— 表现就是代码块第一行突然没了底色和语言角标
    for (const [from, , text] of hidden(BLOCK, BLOCK.length)) {
      expect(text.startsWith('\n')).toBe(true)
      expect(from).toBeGreaterThan(0)
    }
  })

  it('光标进入块内时不再隐藏', () => {
    const inside = BLOCK.indexOf('const a')
    expect(hidden(BLOCK, inside)).toEqual([])
  })

  it('光标贴在围栏边界上也算块内（与行内元素的闭区间规则一致）', () => {
    expect(hidden(BLOCK, BLOCK.indexOf('```js'))).toEqual([])
  })

  it('没有内容行的空代码块不隐藏（藏了只剩一条底色）', () => {
    const empty = '前文\n\n```js\n```\n'
    expect(hidden(empty, 0)).toEqual([])
  })

  it('未闭合的代码块只藏开围栏', () => {
    const unclosed = '前文\n\n```js\nconst a = 1'
    const covered = hidden(unclosed, 0)
    expect(covered.length).toBe(1)
    expect(covered[0]![2]).toContain('```js')
  })

  it('文档以代码块开头时不藏开围栏（往后合并会毁掉内容首行的样式）', () => {
    const atStart = '```js\nconst a = 1\n```\n'
    const covered = hidden(atStart, atStart.length).map(([, , text]) => text)
    // 闭围栏照藏，开围栏留着
    expect(covered.some((t) => t.includes('```js'))).toBe(false)
    expect(covered.length).toBe(1)
  })

  it('缩进代码块不受影响（没有围栏可藏）', () => {
    expect(hidden('前文\n\n    const a = 1\n', 0)).toEqual([])
  })
})

describe('表格分隔行', () => {
  const TABLE = '前文\n\n| a | b |\n| --- | ---: |\n| 1 | 2 |\n\n后文'

  it('光标在表外时整条盖住', () => {
    const covered = hidden(TABLE, 0)
    expect(covered.length).toBe(1)
    expect(covered[0]![2]).toContain('| --- | ---: |')
  })

  it('同样往前吃换行，不往后', () => {
    for (const [from, , text] of hidden(TABLE, 0)) {
      expect(text.startsWith('\n')).toBe(true)
      expect(from).toBeGreaterThan(0)
    }
  })

  it('光标进入表格时露出来', () => {
    expect(hidden(TABLE, TABLE.indexOf('| 1 | 2 |'))).toEqual([])
  })

  it('光标贴在表格边界上也算表内', () => {
    expect(hidden(TABLE, TABLE.indexOf('| a | b |'))).toEqual([])
  })

  it('残缺的表格不会崩', () => {
    expect(() => hidden('| a |\n| ---', 0)).not.toThrow()
  })
})

describe('块级装饰的结构不变量', () => {
  /**
   * 块级替换之间**绝不能重叠** —— 跟行内那条是同一个道理，重叠的 replace
   * 会让 CodeMirror 在渲染时直接抛错。代码围栏和表格分隔行现在是两条独立的
   * 规则，各自往前吃一个换行，挨在一起时就有碰撞的可能。
   */
  it('代码块紧贴表格时两条规则不打架', () => {
    const doc = '前文\n\n```js\nx\n```\n| a |\n| --- |\n| 1 |\n'
    const ranges = hidden(doc, 0)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]![0]).toBeGreaterThanOrEqual(ranges[i - 1]![1])
    }
  })
})
