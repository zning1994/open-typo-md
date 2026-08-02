/**
 * 专注模式的判定（docs/design/02 §8）。
 *
 * 这里只测**纯逻辑**：当前块的范围，以及哪些行会变暗。打字机模式的居中要真
 * 布局才有意义（行高、折行、视口高度都来自 DOM），它归 E2E 管。
 */
import { describe, expect, it } from 'vitest'
import { computeDimDecorations, focusRangeAt } from '@mosu/editor'
import type { EditorState } from '@codemirror/state'
import { mkState } from './helpers.js'

/** 光标在 `cursor` 时，1-based 行号里哪些**变暗**了。 */
function dimmedLines(doc: string, cursor: number): number[] {
  const state = mkState(doc, { selection: cursor })
  const set = computeDimDecorations(state, [{ from: 0, to: state.doc.length }])
  const lines: number[] = []
  const iter = set.iter()
  while (iter.value) {
    lines.push(state.doc.lineAt(iter.from).number)
    iter.next()
  }
  return lines
}

/** 光标在 `cursor` 时**没有**变暗的行号 —— 也就是「当前块」。 */
function litLines(doc: string, cursor: number): number[] {
  const state = mkState(doc, { selection: cursor })
  const dim = new Set(dimmedLines(doc, cursor))
  const lines: number[] = []
  for (let n = 1; n <= state.doc.lines; n++) if (!dim.has(n)) lines.push(n)
  return lines
}

function at(doc: string, needle: string): number {
  const index = doc.indexOf(needle)
  if (index < 0) throw new Error(`测试文档里没有「${needle}」`)
  return index + 1
}

function textOf(state: EditorState, range: { from: number; to: number }): string {
  return state.doc.sliceString(range.from, range.to)
}

describe('focusRangeAt', () => {
  it('一个自然段整体算当前块，哪怕它折了很多行', () => {
    const doc = '第一段\n\n第二段上半\n第二段下半\n\n第三段'
    const state = mkState(doc, { selection: at(doc, '第二段下半') })
    expect(textOf(state, focusRangeAt(state, state.selection.main.head))).toBe(
      '第二段上半\n第二段下半',
    )
  })

  it('标题自成一块', () => {
    const doc = '# 标题\n\n正文'
    const state = mkState(doc, { selection: at(doc, '标题') })
    expect(textOf(state, focusRangeAt(state, state.selection.main.head))).toBe('# 标题')
  })

  it('代码块整体点亮 —— 中间的空行不该把它劈开', () => {
    const doc = '```js\nconst a = 1\n\nconst b = 2\n```\n\n后文'
    const state = mkState(doc, { selection: at(doc, 'const b') })
    expect(textOf(state, focusRangeAt(state, state.selection.main.head))).toBe(
      '```js\nconst a = 1\n\nconst b = 2\n```',
    )
  })

  it('列表里只点亮当前那一项，不是整个列表', () => {
    const doc = '- 第一项\n- 第二项\n- 第三项\n'
    const state = mkState(doc, { selection: at(doc, '第二项') })
    // 项目符号必须在点亮范围里，否则看着像列表少了一项
    expect(textOf(state, focusRangeAt(state, state.selection.main.head))).toContain('- 第二项')
    expect(textOf(state, focusRangeAt(state, state.selection.main.head))).not.toContain(
      '第一项',
    )
  })

  it('引用里按引用内部的块算', () => {
    const doc = '> 引用第一段\n>\n> 引用第二段\n'
    const state = mkState(doc, { selection: at(doc, '引用第二段') })
    expect(textOf(state, focusRangeAt(state, state.selection.main.head))).toContain(
      '引用第二段',
    )
    expect(textOf(state, focusRangeAt(state, state.selection.main.head))).not.toContain(
      '引用第一段',
    )
  })

  it('停在块之间的空行上时退回当前行，而不是把整篇都算成当前块', () => {
    const doc = '第一段\n\n第二段'
    const blank = doc.indexOf('\n') + 1
    const state = mkState(doc, { selection: blank })
    const range = focusRangeAt(state, blank)
    expect(textOf(state, range)).toBe('')
  })
})

describe('computeDimDecorations', () => {
  it('当前块以外的行全部变暗', () => {
    const doc = '第一段\n\n第二段\n\n第三段'
    expect(litLines(doc, at(doc, '第二段'))).toEqual([3])
    expect(dimmedLines(doc, at(doc, '第二段'))).toEqual([1, 2, 4, 5])
  })

  it('段落跨行时整段都亮着', () => {
    const doc = '标题行\n\n上半\n下半\n\n尾巴'
    expect(litLines(doc, at(doc, '下半'))).toEqual([3, 4])
  })

  it('列表项不会多亮出下一行 —— 节点的 to 会盖过换行符', () => {
    const doc = '- 第一项\n- 第二项\n- 第三项\n'
    expect(litLines(doc, at(doc, '第一项'))).toEqual([1])
  })

  it('只处理传进来的范围，范围外一个装饰都不生成', () => {
    const doc = '一\n\n二\n\n三\n\n四'
    const state = mkState(doc, { selection: at(doc, '三') })
    const line1 = state.doc.line(1)
    const set = computeDimDecorations(state, [{ from: line1.from, to: line1.to }])
    let count = 0
    const iter = set.iter()
    while (iter.value) {
      count++
      iter.next()
    }
    expect(count).toBe(1)
  })

  it('空文档不炸', () => {
    expect(dimmedLines('', 0)).toEqual([])
  })
})
