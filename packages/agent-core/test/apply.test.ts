/**
 * Patch 的基线映射。
 *
 * **这一组用的是真的 `ChangeSet`**，不是手搓的 `ChangedRange[]`。理由是 07 §1
 * 那条：替身要顶在系统边界上，不顶在自己的代码上。`mapPatch` 的正确性完全依赖
 * 「`ChangedRange` 就是 CodeMirror `iterChangedRanges` 吐出来的东西」这个前提，
 * 手写替身等于把这个前提也一起假设掉了 —— 那时用例绿着，而真跑起来位置是错的。
 */
import { ChangeSet } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { changedRangesFrom, mapPatch, type ChangedRange } from '../src/apply.js'
import type { Patch } from '../src/patch.js'

/** 造一次「用户在编辑」：返回新文本、改动清单，以及 CodeMirror 自己的 mapPos */
function userEdits(text: string, specs: { from: number; to?: number; insert?: string }[]) {
  const changes = ChangeSet.of(
    specs.map((spec) => ({
      from: spec.from,
      to: spec.to ?? spec.from,
      insert: spec.insert ?? '',
    })),
    text.length,
  )
  return {
    newText: applyTo(text, specs),
    ranges: changedRangesFrom((visit) => changes.iterChangedRanges(visit)),
    length: changes.newLength,
    mapPos: (pos: number, assoc?: number) => changes.mapPos(pos, assoc),
  }
}

/** 直接在字符串上重放一遍，用来算出「用户改完之后文档长什么样」 */
function applyTo(
  text: string,
  specs: { from: number; to?: number; insert?: string }[],
): string {
  let out = ''
  let at = 0
  for (const spec of [...specs].sort((a, b) => a.from - b.from)) {
    out += text.slice(at, spec.from) + (spec.insert ?? '')
    at = spec.to ?? spec.from
  }
  return out + text.slice(at)
}

function applyPatch(text: string, patch: Patch): string {
  let out = ''
  let at = 0
  for (const edit of patch.edits) {
    out += text.slice(at, edit.from) + edit.insert
    at = edit.to
  }
  return out + text.slice(at)
}

const patchOf = (edits: Patch['edits'], baseVersion = 1): Patch => ({
  baseVersion,
  edits,
  summary: 'test',
})

describe('mapPatch', () => {
  it('版本没变就原样应用', () => {
    const patch = patchOf([{ from: 2, to: 5, insert: 'X' }])
    const result = mapPatch({ patch, current: { version: 1, length: 10 }, changes: [] })
    expect(result.status).toBe('clean')
    expect(result.status === 'clean' && result.patch).toBe(patch)
  })

  it('拿不到中间发生了什么就拒绝，而不是假设什么都没发生', () => {
    const patch = patchOf([{ from: 2, to: 5, insert: 'X' }])
    const result = mapPatch({ patch, current: { version: 9, length: 10 }, changes: null })
    expect(result.status).toBe('unknown-baseline')
  })

  it('用户在别处打字：位置挪好，改的还是原来那几个字', () => {
    const text = 'The quick brown fox jumps'
    //            0123456789
    const edit = { from: 4, to: 9, insert: 'slow' } //「quick」→「slow」
    const user = userEdits(text, [{ from: 0, insert: 'Once, ' }])

    const result = mapPatch({
      patch: patchOf([edit]),
      current: { version: 2, length: user.length },
      changes: user.ranges,
    })

    expect(result.status).toBe('mapped')
    if (result.status !== 'mapped') return
    expect(applyPatch(user.newText, result.patch)).toBe('Once, The slow brown fox jumps')
    expect(result.patch.baseVersion).toBe(2)
  })

  it('用户改到了 AI 要改的那一段 —— 拒绝，不猜', () => {
    const text = 'The quick brown fox jumps'
    const user = userEdits(text, [{ from: 6, to: 7, insert: 'X' }]) // 落在 [4,9) 里面

    const result = mapPatch({
      patch: patchOf([{ from: 4, to: 9, insert: 'slow' }]),
      current: { version: 2, length: user.length },
      changes: user.ranges,
    })

    expect(result.status).toBe('stale')
    expect(result.status === 'stale' && result.conflicts).toEqual([0])
  })

  it('只冲突的那几条被列出来，其余的下标要对得上', () => {
    const text = 'aaaa bbbb cccc dddd'
    const user = userEdits(text, [{ from: 11, to: 12, insert: 'X' }]) // 落在 [10,14) 里

    const result = mapPatch({
      patch: patchOf([
        { from: 0, to: 4, insert: 'A' },
        { from: 5, to: 9, insert: 'B' },
        { from: 10, to: 14, insert: 'C' },
      ]),
      current: { version: 2, length: user.length },
      changes: user.ranges,
    })

    expect(result.status === 'stale' && result.conflicts).toEqual([2])
  })

  describe('相邻不算冲突 —— 这正是不能直接用 touchesRange 的原因', () => {
    // 这一条曾经是红的：两端用同一个 assoc 时，末端把用户刚打的字一起吃掉了
    it('用户紧跟在 AI 要改的那一段后面打字 —— 那几个字必须还在', () => {
      const text = 'Hello world'
      const user = userEdits(text, [{ from: 5, insert: ', dear' }])

      // touchesRange 对这一对会返回 true —— 而这里必须是「可以映射」
      const raw = ChangeSet.of({ from: 5, to: 5, insert: ', dear' }, text.length)
      expect(raw.touchesRange(0, 5)).toBe(true)

      const result = mapPatch({
        patch: patchOf([{ from: 0, to: 5, insert: 'Goodbye' }]),
        current: { version: 2, length: user.length },
        changes: user.ranges,
      })
      expect(result.status).toBe('mapped')
      if (result.status !== 'mapped') return
      expect(applyPatch(user.newText, result.patch)).toBe('Goodbye, dear world')
    })

    it('用户删掉的那一段紧挨着 AI 要改的那一段', () => {
      const text = 'one two three'
      //            0123456789...  删 [0,4)「one 」
      const user = userEdits(text, [{ from: 0, to: 4 }])

      const result = mapPatch({
        patch: patchOf([{ from: 4, to: 7, insert: 'TWO' }]),
        current: { version: 2, length: user.length },
        changes: user.ranges,
      })
      expect(result.status).toBe('mapped')
      if (result.status !== 'mapped') return
      expect(applyPatch(user.newText, result.patch)).toBe('TWO three')
    })
  })

  describe('纯插入', () => {
    it('插入点落在被删掉的文本内部 —— 冲突', () => {
      const text = 'alpha beta gamma'
      const user = userEdits(text, [{ from: 6, to: 10 }]) // 删掉「beta」
      const result = mapPatch({
        patch: patchOf([{ from: 8, to: 8, insert: '!' }]),
        current: { version: 2, length: user.length },
        changes: user.ranges,
      })
      expect(result.status).toBe('stale')
    })

    it('用户恰好在插入点打字：AI 的内容接在用户打的字后面', () => {
      const text = 'alpha beta'
      const user = userEdits(text, [{ from: 10, insert: ' USER' }])
      const result = mapPatch({
        patch: patchOf([{ from: 10, to: 10, insert: ' AI' }]),
        current: { version: 2, length: user.length },
        changes: user.ranges,
      })
      expect(result.status).toBe('mapped')
      if (result.status !== 'mapped') return
      expect(applyPatch(user.newText, result.patch)).toBe('alpha beta USER AI')
    })
  })

  it('多次编辑复合之后，两个端点都跟 CodeMirror 自己的 mapPos 对得上', () => {
    //             0         1         2         3
    //             01234567890123456789012345678901
    const text = 'aaaaaaaaaa bbbbbbbbbb cccccccccc'
    const user = userEdits(text, [
      { from: 0, to: 3, insert: 'X' }, // −2
      { from: 11, insert: 'YY' }, //      +2
      { from: 25, to: 30 }, //            −5
    ])
    expect(user.newText).toBe('Xaaaaaaa YYbbbbbbbbbb ccccc')

    // AI 要改的是 [15,19)（四个 b），跟上面三处都不重叠
    const result = mapPatch({
      patch: patchOf([{ from: 15, to: 19, insert: 'ZZ' }]),
      current: { version: 2, length: user.length },
      changes: user.ranges,
    })

    expect(result.status).toBe('mapped')
    if (result.status !== 'mapped') return
    // 起点贴后面的文本，末端贴前面的 —— 这两个 assoc 就是上面那条 bug 的根因
    expect(result.patch.edits[0]!.from).toBe(user.mapPos(15, 1))
    expect(result.patch.edits[0]!.to).toBe(user.mapPos(19, -1))
    expect(applyPatch(user.newText, result.patch)).toBe('Xaaaaaaa YYbbbbZZbb ccccc')
  })

  it('改动清单的顺序不影响结果', () => {
    const text = 'aaaa bbbb cccc'
    const user = userEdits(text, [
      { from: 0, to: 1 },
      { from: 5, insert: 'Z' },
    ])
    const forwards = mapPatch({
      patch: patchOf([{ from: 10, to: 14, insert: 'C' }]),
      current: { version: 2, length: user.length },
      changes: user.ranges,
    })
    const backwards = mapPatch({
      patch: patchOf([{ from: 10, to: 14, insert: 'C' }]),
      current: { version: 2, length: user.length },
      changes: [...user.ranges].reverse() as ChangedRange[],
    })
    expect(forwards).toEqual(backwards)
  })
})

describe('changedRangesFrom', () => {
  it('摊出来的就是 iterChangedRanges 给的那四个数', () => {
    const changes = ChangeSet.of(
      [
        { from: 2, to: 6 },
        { from: 12, to: 12, insert: 'ABC' },
      ],
      20,
    )
    expect(changedRangesFrom((visit) => changes.iterChangedRanges(visit))).toEqual([
      { fromA: 2, toA: 6, fromB: 2, toB: 2 },
      { fromA: 12, toA: 12, fromB: 8, toB: 11 },
    ])
  })
})
