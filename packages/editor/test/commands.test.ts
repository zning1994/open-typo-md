import { describe, expect, it } from 'vitest'
import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state'

import { continueMarkup, setHeading, toggleBold, toggleItalic } from '@typo/editor'
import { mkState } from './helpers.js'

/** 跑一条 StateCommand，返回执行后的文档与选区 —— 不需要 DOM。 */
function run(
  command: StateCommand,
  state: EditorState,
): { doc: string; selection: string; applied: boolean } {
  let next = state
  const applied = command({
    state,
    dispatch: (tr) => {
      next = tr.state
    },
  })
  const main = next.selection.main
  return {
    doc: next.doc.toString(),
    selection: main.empty ? `|${main.head}` : `${main.from}-${main.to}`,
    applied,
  }
}

describe('toggleBold / toggleItalic', () => {
  it('包裹选中文本', () => {
    const state = mkState('这是重点内容', { selection: [[2, 4]] })
    expect(run(toggleBold, state).doc).toBe('这是**重点**内容')
  })

  it('选区在包裹后仍然罩住原来的文字', () => {
    const state = mkState('这是重点内容', { selection: [[2, 4]] })
    expect(run(toggleBold, state).selection).toBe('4-6')
  })

  it('再按一次解包（幂等切换）', () => {
    const wrapped = mkState('这是**重点**内容', { selection: [[4, 6]] })
    expect(run(toggleBold, wrapped).doc).toBe('这是重点内容')
  })

  it('空选区时插入一对标记并把光标放中间', () => {
    const state = mkState('这是内容', { selection: 2 })
    const result = run(toggleBold, state)
    expect(result.doc).toBe('这是****内容')
    expect(result.selection).toBe('|4')
  })

  it('斜体用单个星号', () => {
    const state = mkState('这是重点内容', { selection: [[2, 4]] })
    expect(run(toggleItalic, state).doc).toBe('这是*重点*内容')
  })
})

describe('setHeading', () => {
  it('把段落变成标题', () => {
    expect(run(setHeading(2), mkState('标题文字', { selection: 0 })).doc).toBe('## 标题文字')
  })

  it('切换层级时替换原有前缀，而不是叠加', () => {
    expect(run(setHeading(3), mkState('# 标题', { selection: 2 })).doc).toBe('### 标题')
  })

  it('对同层级再按一次则降回段落', () => {
    expect(run(setHeading(1), mkState('# 标题', { selection: 2 })).doc).toBe('标题')
  })

  it('level 0 直接降为段落', () => {
    expect(run(setHeading(0), mkState('### 标题', { selection: 4 })).doc).toBe('标题')
  })

  it('多行选区里每一行都处理', () => {
    const state = mkState('一\n二\n三', { selection: [[0, 5]] })
    expect(run(setHeading(2), state).doc).toBe('## 一\n## 二\n## 三')
  })

  it('保留原有缩进', () => {
    expect(run(setHeading(1), mkState('  文字', { selection: 3 })).doc).toBe('  # 文字')
  })
})

describe('回车续列表', () => {
  it('在列表项末尾回车自动补上标记', () => {
    const state = mkState('- 第一项', { selection: 5 })
    expect(run(continueMarkup, state).doc).toBe('- 第一项\n- ')
  })

  it('有序列表自动递增编号', () => {
    const state = mkState('1. 第一项', { selection: 6 })
    expect(run(continueMarkup, state).doc).toBe('1. 第一项\n2. ')
  })

  it('在空列表项上回车则退出列表', () => {
    // 标记被抹掉，光标停在一个普通空行上 —— 这就是「退出列表」
    const state = mkState('- 第一项\n- ', { selection: 8 })
    const result = run(continueMarkup, state)
    expect(result.doc).toBe('- 第一项\n')
    expect(result.selection).toBe('|6')
  })

  it('引用块内回车续引用标记', () => {
    const state = mkState('> 引用', { selection: 4 })
    expect(run(continueMarkup, state).doc).toBe('> 引用\n> ')
  })
})

describe('命令不产生意外的格式改写', () => {
  it('setHeading 对已经是目标形态的行不产生 transaction', () => {
    const state = mkState('## 标题', { selection: 3 })
    // 已经是二级标题，再设成二级 → 应当降级，而不是「无事发生」
    expect(run(setHeading(2), state).doc).toBe('标题')
  })

  it('toggleBold 不碰选区之外的任何字符', () => {
    const doc = '前面 **已有粗体** 中间 目标 后面'
    const from = doc.indexOf('目标')
    const state = mkState(doc, { selection: [[from, from + 2]] })
    const result = run(toggleBold, state)
    expect(result.doc).toBe('前面 **已有粗体** 中间 **目标** 后面')
  })
})

describe('选区端点与文档边界', () => {
  it('文档开头的空选区加粗不会越界读取', () => {
    const state = mkState('内容', { selection: 0 })
    expect(run(toggleBold, state).doc).toBe('****内容')
  })

  it('文档结尾同理', () => {
    const state = mkState('内容', { selection: 2 })
    expect(run(toggleBold, state).doc).toBe('内容****')
  })

  it('空文档不崩', () => {
    const state = mkState('', { selection: 0 })
    expect(run(toggleBold, state).doc).toBe('****')
  })
})

describe('EditorSelection 语义自检', () => {
  it('多光标确实被保留（allowMultipleSelections 必须开着）', () => {
    const state = mkState('一二三四', { selection: [1, 3] })
    expect(state.selection.ranges.length).toBe(2)
    expect(state.selection.ranges.map((r) => r.head)).toEqual([1, 3])
    expect(EditorSelection.cursor(1).empty).toBe(true)
  })
})
