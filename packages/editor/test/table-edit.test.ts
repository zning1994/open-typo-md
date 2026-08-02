/**
 * 表格编辑命令。
 *
 * 全部命令都是纯文本变换（见 table-edit.ts 的说明），所以这里直接断言
 * **变换后的源码**。这不是在测实现细节 —— 源码优先模型下，源码就是产品本身：
 * 用户保存下去的、别人 diff 看到的、就是这段文本。
 */
import { describe, expect, it } from 'vitest'
import type { TransactionSpec } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'
import {
  displayWidth,
  locate,
  parseTable,
  serializeTable,
  tableAlignColumn,
  tableAt,
  tableDeleteColumn,
  tableDeleteRow,
  tableFormat,
  tableInsert,
  tableInsertColumnAfter,
  tableInsertColumnBefore,
  tableInsertRowAbove,
  tableInsertRowBelow,
  tableNextCell,
  tableNextRow,
  tablePrevCell,
} from '@mosu/editor'
import { mkState } from './helpers.js'

/**
 * 跑一条命令。
 *
 * 命令只用到 `view.state` 与 `view.dispatch`，所以这里用一个只实现这两样的
 * 替身 —— 这样表格逻辑能在 node 环境下测，不必为它拉起一个真 DOM。
 * 真实浏览器里才成立的部分（键位、焦点、渲染）由 E2E 覆盖。
 */
function run(
  command: Command,
  doc: string,
  cursor: number,
): { doc: string; from: number; to: number; handled: boolean } {
  let state = mkState(doc, { selection: cursor })
  const view = {
    get state() {
      return state
    },
    dispatch: (spec: TransactionSpec) => {
      state = state.update(spec).state
    },
  } as unknown as EditorView

  const handled = command(view)
  const range = state.selection.main
  return { doc: state.doc.toString(), from: range.from, to: range.to, handled }
}

/** 光标偏移：`needle` 在文档里第 `nth` 次出现的位置。 */
function at(doc: string, needle: string, nth = 0): number {
  let index = -1
  for (let i = 0; i <= nth; i++) index = doc.indexOf(needle, index + 1)
  if (index < 0) throw new Error(`找不到「${needle}」的第 ${nth} 次出现`)
  return index
}

const TABLE = ['| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |'].join('\n')

describe('显示宽度', () => {
  it('中日韩文字占两格 —— 不然中文表格在源码里是歪的', () => {
    expect(displayWidth('甲')).toBe(2)
    expect(displayWidth('ab')).toBe(2)
    expect(displayWidth('甲乙')).toBe(4)
    expect(displayWidth('中a')).toBe(3)
  })

  it('空串是 0', () => {
    expect(displayWidth('')).toBe(0)
  })
})

describe('读表格', () => {
  const model = (doc: string) => {
    const state = mkState(doc, { selection: 0 })
    const table = tableAt(state, 0)
    expect(table).not.toBeNull()
    return parseTable(state, table!)!
  }

  it('表头与正文行，分隔行不算一行', () => {
    const parsed = model(TABLE)
    expect(parsed.rows).toEqual([
      ['甲', '乙'],
      ['1', '2'],
    ])
    expect(parsed.columns).toBe(2)
  })

  it('对齐方式从分隔行读出来', () => {
    const parsed = model('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |')
    expect(parsed.aligns).toEqual(['left', 'center', 'right'])
  })

  it('首尾竖线可省略', () => {
    const parsed = model('a | b\n--- | ---\n1 | 2')
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('某一行比表头多一格时**按多的算** —— 归一等于静默删字', () => {
    const parsed = model('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |')
    expect(parsed.columns).toBe(3)
    expect(parsed.rows[1]).toEqual(['1', '2', '3'])
  })

  it('不在表格里时找不到表格', () => {
    const state = mkState('就是一段话', { selection: 2 })
    expect(tableAt(state, 2)).toBeNull()
  })
})

describe('定位光标所在格', () => {
  const locateAt = (doc: string, pos: number) => {
    const state = mkState(doc, { selection: pos })
    return locate(state, tableAt(state, pos)!, pos)
  }

  it('表头、正文、分隔行各自认得出来', () => {
    expect(locateAt(TABLE, at(TABLE, '甲'))).toEqual({ row: 0, column: 0 })
    expect(locateAt(TABLE, at(TABLE, '乙'))).toEqual({ row: 0, column: 1 })
    expect(locateAt(TABLE, at(TABLE, '1'))).toEqual({ row: 1, column: 0 })
    expect(locateAt(TABLE, at(TABLE, '2'))).toEqual({ row: 1, column: 1 })
    expect(locateAt(TABLE, at(TABLE, '---'))).toEqual({ row: 'delimiter', column: 0 })
  })
})

describe('写回文本', () => {
  it('按显示宽度对齐竖线', () => {
    const { doc } = run(tableFormat, '| 甲 | b |\n| --- | --- |\n| 一二三 | dd |', 3)
    expect(doc).toBe(['| 甲     | b   |', '| ------ | --- |', '| 一二三 | dd  |'].join('\n'))
  })

  it('分隔行至少三个短横 —— 少于三个不是合法的 GFM 分隔行', () => {
    const { doc } = run(tableFormat, '| a |\n| - |\n| b |', 3)
    expect(doc).toBe(['| a   |', '| --- |', '| b   |'].join('\n'))
  })

  it('对齐方式写成冒号', () => {
    const state = mkState(TABLE, { selection: 0 })
    const model = parseTable(state, tableAt(state, 0)!)!
    model.aligns = ['center', 'right']
    // 冒号占掉短横的位置而不是撑宽格子 —— 各列宽度因此不受对齐方式影响
    expect(serializeTable(model).text.split('\n')[1]).toBe('| :-: | --: |')
  })
})

describe('Tab / Shift+Tab 只移动光标', () => {
  it('往右一格，文档一个字都不改', () => {
    const result = run(tableNextCell, TABLE, at(TABLE, '甲'))
    expect(result.doc).toBe(TABLE)
    expect(result.handled).toBe(true)
    // 选中目标格的内容：Tab 过去接着敲就是替换
    expect(TABLE.slice(result.from, result.to)).toBe('乙')
  })

  it('行末换到下一行第一格', () => {
    const result = run(tableNextCell, TABLE, at(TABLE, '乙'))
    expect(result.doc).toBe(TABLE)
    expect(TABLE.slice(result.from, result.to)).toBe('1')
  })

  it('分隔行上按 Tab 直接去正文，不在分隔行里横着走', () => {
    const result = run(tableNextCell, TABLE, at(TABLE, '---'))
    expect(TABLE.slice(result.from, result.to)).toBe('1')
  })

  it('最后一格按 Tab 新起一行 —— 这是搭表格最顺手的方式', () => {
    const result = run(tableNextCell, TABLE, at(TABLE, '2'))
    expect(result.doc).toBe(
      ['| 甲  | 乙  |', '| --- | --- |', '| 1   | 2   |', '|     |     |'].join('\n'),
    )
  })

  it('Shift+Tab 往左，第一格时原地不动但仍然消费掉按键', () => {
    const back = run(tablePrevCell, TABLE, at(TABLE, '1'))
    expect(TABLE.slice(back.from, back.to)).toBe('乙')

    // 落到通用 Tab 命令上会往表头插一个制表符，表格当场散架
    const stuck = run(tablePrevCell, TABLE, at(TABLE, '甲'))
    expect(stuck.doc).toBe(TABLE)
    expect(stuck.handled).toBe(true)
  })

  it('不在表格里时交还给别人处理', () => {
    expect(run(tableNextCell, '普通段落', 2).handled).toBe(false)
    expect(run(tablePrevCell, '普通段落', 2).handled).toBe(false)
  })
})

describe('回车', () => {
  it('去下一行的第一格', () => {
    const result = run(tableNextRow, TABLE, at(TABLE, '乙'))
    expect(result.doc).toBe(TABLE)
    expect(TABLE.slice(result.from, result.to)).toBe('1')
  })

  it('表尾的回车交还给默认行为 —— 手敲表格时接管会把下一行插进单元格里', () => {
    const result = run(tableNextRow, TABLE, at(TABLE, '1'))
    expect(result.handled).toBe(false)
    expect(result.doc).toBe(TABLE)
  })

  it('刚敲完分隔行时的回车也交还 —— 那正是要接着敲第一条正文的时刻', () => {
    const justHeader = '| a | b |\n| --- | --- |'
    const result = run(tableNextRow, justHeader, justHeader.length)
    expect(result.handled).toBe(false)
    expect(result.doc).toBe(justHeader)
  })

  it('在空的末行回车 = 退出表格 —— 否则用户被困在表里出不来', () => {
    const doc = `${TABLE}\n|  |  |`
    const result = run(tableNextRow, doc, doc.length - 3)
    // 两个换行。一个是不够的：GFM 里表格行之后紧邻的非空行**还是表格行**，
    // 用户「被送出表格」之后敲的第一个字会把自己送回去（issue #10）。
    // 这条用例原来钉的正是那个坏行为
    expect(result.doc).toBe(
      `${TABLE.replace(/\| 甲 \| 乙 \|/, '| 甲  | 乙  |').replace('| 1 | 2 |', '| 1   | 2   |')}\n\n`,
    )
    expect(result.from).toBe(result.doc.length)
  })

  it('退出之后敲的字确实落在表格外面 —— 这才是这条出口的意义', () => {
    const doc = `${TABLE}\n|  |  |`
    const exited = run(tableNextRow, doc, doc.length - 3)
    // 在光标处接着敲，产出的源码里那句话不能变成一个单元格
    const typed = exited.doc.slice(0, exited.from) + '正文' + exited.doc.slice(exited.from)
    expect(typed.endsWith('\n\n正文')).toBe(true)
    // 最后一行是纯文本，不带任何竖线
    expect(typed.split('\n').at(-1)).toBe('正文')
  })
})

describe('增删行列', () => {
  it('在下方插入一行', () => {
    const { doc } = run(tableInsertRowBelow, TABLE, at(TABLE, '1'))
    expect(doc.split('\n')).toEqual([
      '| 甲  | 乙  |',
      '| --- | --- |',
      '| 1   | 2   |',
      '|     |     |',
    ])
  })

  it('在上方插入一行；光标在表头时插到正文最前，不会插到表头前面', () => {
    const { doc } = run(tableInsertRowAbove, TABLE, at(TABLE, '甲'))
    expect(doc.split('\n')).toEqual([
      '| 甲  | 乙  |',
      '| --- | --- |',
      '|     |     |',
      '| 1   | 2   |',
    ])
  })

  it('删除正文行', () => {
    const { doc } = run(tableDeleteRow, TABLE, at(TABLE, '1'))
    expect(doc.split('\n')).toEqual(['| 甲  | 乙  |', '| --- | --- |'])
  })

  it('删表头时把第一条正文顶上来 —— GFM 的表格必须有表头', () => {
    const { doc } = run(tableDeleteRow, TABLE, at(TABLE, '甲'))
    expect(doc.split('\n')).toEqual(['| 1   | 2   |', '| --- | --- |'])
  })

  it('只剩一行时拒绝删除 —— 那等于删掉整张表，不替用户做这个决定', () => {
    const only = '| a |\n| --- |'
    const result = run(tableDeleteRow, only, at(only, 'a'))
    expect(result.handled).toBe(false)
    expect(result.doc).toBe(only)
  })

  it('左右插入列，对齐方式跟着挪', () => {
    const doc = '| a | b |\n| :-- | --: |\n| 1 | 2 |'
    const after = run(tableInsertColumnAfter, doc, at(doc, 'a'))
    expect(after.doc.split('\n')[1]).toBe('| :-- | --- | --: |')

    const before = run(tableInsertColumnBefore, doc, at(doc, 'b'))
    expect(before.doc.split('\n')[0]).toBe('| a   |     | b   |')
  })

  it('删除列', () => {
    const { doc } = run(tableDeleteColumn, TABLE, at(TABLE, '乙'))
    expect(doc.split('\n')).toEqual(['| 甲  |', '| --- |', '| 1   |'])
  })

  it('只剩一列时拒绝删除', () => {
    const only = '| a |\n| --- |\n| 1 |'
    expect(run(tableDeleteColumn, only, at(only, 'a')).handled).toBe(false)
  })
})

describe('对齐', () => {
  it('只改分隔行，正文一个字不动', () => {
    const { doc } = run(tableAlignColumn('center'), TABLE, at(TABLE, '1'))
    expect(doc.split('\n')).toEqual(['| 甲  | 乙  |', '| :-: | --- |', '| 1   | 2   |'])
  })

  it('分隔行上也能改，改的是它自己那一列', () => {
    const { doc } = run(tableAlignColumn('right'), TABLE, at(TABLE, '---', 1))
    expect(doc.split('\n')[1]).toBe('| --- | --: |')
  })
})

describe('插入新表格', () => {
  it('在空行上插入', () => {
    const { doc, handled } = run(tableInsert(2, 2), '前文\n\n', 4)
    expect(handled).toBe(true)
    expect(doc).toBe('前文\n\n|     |     |\n| --- | --- |\n|     |     |\n')
  })

  it('行内有字时先换行 —— 表格必须自成一块', () => {
    const { doc } = run(tableInsert(1, 2), '前文', 2)
    expect(doc.startsWith('前文\n|')).toBe(true)
  })

  it('已经在表格里时拒绝 —— 免得嵌出一张不成立的表', () => {
    expect(run(tableInsert(2, 2), TABLE, at(TABLE, '甲')).handled).toBe(false)
  })
})

/**
 * 嵌在 blockquote / 列表项里的表格（issue #8）。
 *
 * 这些用例之前一条都没有 —— 整个文件里**没有一张表格不是从第 0 列开始的**。
 * 于是两个缺陷一直藏着：
 *
 * 1. `contentRanges` 用「首个非空白位置」判断有没有前导竖线，而 `> ` 里的 `>`
 *    是非空白字符，于是 `"> "` 成了第 0 个单元格 —— 三列表格变四列；
 * 2. `serializeTable` 不带任何前缀，第二行往后当场掉出 blockquote / 列表项。
 *
 * 判据用**源码**：源码优先模型下，源码就是产品本身。
 */
describe('嵌套在别的块里的表格', () => {
  const QUOTED = ['> | 甲 | 乙 |', '> | --- | --- |', '> | 1 | 2 |'].join('\n')

  it('引用块里的表格：列数是三列不是四列，`>` 不是内容', () => {
    const state = mkState(QUOTED, { selection: QUOTED.length })
    const table = tableAt(state, QUOTED.length)
    expect(table).not.toBeNull()
    const model = parseTable(state, table!)
    expect(model?.columns).toBe(2)
    expect(model?.rows).toEqual([
      ['甲', '乙'],
      ['1', '2'],
    ])
    expect(model?.prefix).toBe('> ')
  })

  it('格式化之后每一行都还在引用块里', () => {
    const { doc } = run(tableFormat, QUOTED, QUOTED.length)
    expect(doc).toBe(['> | 甲  | 乙  |', '> | --- | --- |', '> | 1   | 2   |'].join('\n'))
    // 每一行都得带 `> `，少一行就是内容跑出了引用块
    for (const line of doc.split('\n')) expect(line.startsWith('> ')).toBe(true)
  })

  it('末格按 Tab 长出的新行也带着前缀', () => {
    // 报告里的真机复现就是这个：连按三次 Tab，第三次触发重排
    const { doc } = run(tableNextCell, QUOTED, at(QUOTED, '2'))
    expect(doc).toBe(
      ['> | 甲  | 乙  |', '> | --- | --- |', '> | 1   | 2   |', '> |     |     |'].join('\n'),
    )
  })

  it('插入行同样带前缀', () => {
    const { doc } = run(tableInsertRowBelow, QUOTED, at(QUOTED, '1'))
    for (const line of doc.split('\n')) expect(line.startsWith('> ')).toBe(true)
    expect(doc.split('\n')).toHaveLength(4)
  })

  it('插入列不会把 `>` 算成一列', () => {
    const { doc } = run(tableInsertColumnAfter, QUOTED, at(QUOTED, '甲'))
    const cells = (doc.split('\n')[0] ?? '').split('|').length
    // `> | 甲 | 新 | 乙 |` —— split 出 5 段（首尾各一个空串）
    expect(cells).toBe(5)
  })

  it('Tab 在第一格上按，先去第二格而不是被 `>` 挡住', () => {
    const { from, to, doc } = run(tableNextCell, QUOTED, at(QUOTED, '甲'))
    // 只移动光标，不改文档
    expect(doc).toBe(QUOTED)
    expect(doc.slice(from, to)).toBe('乙')
  })

  const LISTED = ['- item', '', '  | 甲 | 乙 |', '  | --- | --- |', '  | 1 | 2 |'].join('\n')

  it('列表项里的表格：重排之后缩进还在，仍然是一张表', () => {
    const { doc } = run(tableFormat, LISTED, at(LISTED, '1'))
    expect(doc).toBe(
      ['- item', '', '  | 甲  | 乙  |', '  | --- | --- |', '  | 1   | 2   |'].join('\n'),
    )
  })

  it('引用块里插一张新表，每一行都带 `> `', () => {
    const doc = '> 引用正文'
    const result = run(tableInsert(2, 2), doc, doc.length)
    expect(result.handled).toBe(true)
    for (const line of result.doc.split('\n')) {
      if (line.trim() === '') continue
      expect(line.startsWith('> ')).toBe(true)
    }
  })

  it('顶层表格的前缀是空串 —— 不该凭空多出缩进', () => {
    const state = mkState(TABLE, { selection: 0 })
    const model = parseTable(state, tableAt(state, 0)!)
    expect(model?.prefix).toBe('')
    expect(run(tableFormat, TABLE, at(TABLE, '1')).doc.split('\n')[0]?.startsWith('|')).toBe(
      true,
    )
  })
})
