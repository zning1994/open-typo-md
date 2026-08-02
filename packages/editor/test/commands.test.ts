import { describe, expect, it } from 'vitest'
import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state'

import {
  continueMarkup,
  setHeading,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
} from '@mosu/editor'
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

/**
 * `toggleWrap` 的三个 marker 缺陷（issue #9）。
 *
 * 三条的共同点是**产出的 Markdown 语义变了**，而不只是难看：
 * 用户按下的是「加粗」，得到的是四个字面星号；按下「斜体」，粗体没了。
 */
describe('包裹命令的边界', () => {
  describe('选区带空白（9a）', () => {
    it('尾随空格被挤出去 —— 不然 `**def **` 按 CommonMark 根本不是强调', () => {
      // spec 例 391：`**foo bar **` 按字面渲染
      const state = mkState('abc def ghi', { selection: [[4, 8]] })
      expect(run(toggleBold, state).doc).toBe('abc **def** ghi')
    })

    it('前导空格同样挤出去', () => {
      // spec 例 379：`** foo bar**` 按字面渲染
      const state = mkState('abc def ghi', { selection: [[3, 7]] })
      expect(run(toggleBold, state).doc).toBe('abc **def** ghi')
    })

    it('斜体也一样', () => {
      const state = mkState('abc def ghi', { selection: [[4, 8]] })
      expect(run(toggleItalic, state).doc).toBe('abc *def* ghi')
    })

    it('「选中一整行再 Cmd-B」不会把闭合标记甩到下一行', () => {
      // 这是最常见的那一种：选区末尾带着换行符
      const state = mkState('para one\npara two', { selection: [[0, 9]] })
      expect(run(toggleBold, state).doc).toBe('**para one**\npara two')
    })

    it('选中的全是空白时退回「在光标处插入一对标记」', () => {
      const state = mkState('a  b', { selection: [[1, 3]] })
      expect(run(toggleBold, state).doc).toBe('a****  b')
    })

    it('挤完之后选区还罩着原来的字', () => {
      const state = mkState('abc def ghi', { selection: [[4, 8]] })
      expect(run(toggleBold, state).selection).toBe('6-9')
    })
  })

  describe('行内代码的围栏长度（9b）', () => {
    it('内容里有反引号时围栏加长 —— 不然只有半截成了代码', () => {
      const state = mkState('use a`b here', { selection: [[4, 7]] })
      expect(run(toggleInlineCode, state).doc).toBe('use ``a`b`` here')
    })

    it('内容里有两个连续反引号时围栏用三个', () => {
      const state = mkState('x a``b y', { selection: [[2, 6]] })
      expect(run(toggleInlineCode, state).doc).toBe('x ```a``b``` y')
    })

    it('内容以反引号开头或结尾时两侧各垫一个空格', () => {
      // 不垫的话 `` `x` `` 会跟围栏连成一片
      const state = mkState('a `x` b', { selection: [[2, 5]] })
      expect(run(toggleInlineCode, state).doc).toBe('a `` `x` `` b')
    })

    it('没有反引号时还是一个反引号，不平白加长', () => {
      const state = mkState('这是代码内容', { selection: [[2, 4]] })
      expect(run(toggleInlineCode, state).doc).toBe('这是`代码`内容')
    })

    it('再按一次解包', () => {
      const state = mkState('这是`代码`内容', { selection: [[3, 5]] })
      expect(run(toggleInlineCode, state).doc).toBe('这是代码内容')
    })
  })

  describe('解包时的 marker 长度（9c）', () => {
    it('对已加粗的文字按斜体，得到粗斜体而不是把粗体吃掉', () => {
      // 真机流程：Cmd-B 得到 `这是**重点**内容`，保持选区不动再按 Cmd-I
      const state = mkState('这是**重点**内容', { selection: [[4, 6]] })
      expect(run(toggleItalic, state).doc).toBe('这是***重点***内容')
    })

    it('这跟直接敲 `*` 的结果一致 —— 快捷键和按键不该给出两个答案', () => {
      // input.ts 的 wrapSelection 没有解包分支，一直给的就是 `***重点***`
      const state = mkState('这是**重点**内容', { selection: [[4, 6]] })
      expect(run(toggleItalic, state).doc).toBe('这是***重点***内容')
    })

    it('对粗斜体按斜体，脱掉的是斜体那一层', () => {
      const state = mkState('这是***重点***内容', { selection: [[5, 7]] })
      expect(run(toggleItalic, state).doc).toBe('这是**重点**内容')
    })

    it('对已斜体的文字按加粗，两层都在', () => {
      const state = mkState('这是*重点*内容', { selection: [[3, 5]] })
      expect(run(toggleBold, state).doc).toBe('这是***重点***内容')
    })

    it('对纯粗体按加粗仍然正常解包', () => {
      const state = mkState('这是**重点**内容', { selection: [[4, 6]] })
      expect(run(toggleBold, state).doc).toBe('这是重点内容')
    })

    it('删除线同理', () => {
      const state = mkState('这是~~重点~~内容', { selection: [[4, 6]] })
      expect(run(toggleStrikethrough, state).doc).toBe('这是重点内容')
    })
  })
})
