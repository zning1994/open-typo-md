/**
 * Markdown 编辑命令与键位。
 *
 * 源码优先模型在这里省了一大块工作：用户敲 `# ` 时缓冲区里本来就是 `# `，
 * 标题自动就出现了，不需要「输入规则 → 转换成标题节点」那一套。
 * 真正需要写的只有下面这些「替用户操作源码」的命令（docs/design/02 §7）。
 */
import {
  indentLess,
  indentMore,
  insertTab,
  history,
  historyKeymap,
  defaultKeymap,
} from '@codemirror/commands'
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
} from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { EditorSelection, type Extension, type StateCommand } from '@codemirror/state'
import { keymap, type Command, type KeyBinding } from '@codemirror/view'
import { BLOCK_NODES, headingLevel } from '@typo/markdown'

/**
 * 用成对标记包裹选区；已经被包裹则解包。
 *
 * 解包时刻意只看紧邻选区的字符，而不去查语法树 —— 用户选中 `粗体` 两个字
 * 按 Ctrl+B，期望的是把外面那对 `**` 去掉，而不是把整个段落的强调结构重算。
 */
export function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const len = marker.length
    const tr = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - len, range.from)
      const after = state.sliceDoc(range.to, range.to + len)

      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - len, to: range.from },
            { from: range.to, to: range.to + len },
          ],
          range: EditorSelection.range(range.from - len, range.to - len),
        }
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: range.empty
          ? EditorSelection.cursor(range.from + len)
          : EditorSelection.range(range.from + len, range.to + len),
      }
    })
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.typo.wrap' }))
    return true
  }
}

const ATX_PREFIX = /^(\s*)(#{1,6}[ \t]+)?/

/**
 * 设置选中各行的标题层级。level 为 0 表示降级为普通段落；
 * 对已经是该层级的行再按一次同样降级（符合「切换」的直觉）。
 */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const changes: { from: number; to: number; insert: string }[] = []
    const handled = new Set<number>()

    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number
      const last = state.doc.lineAt(range.to).number
      for (let n = first; n <= last; n++) {
        if (handled.has(n)) continue
        handled.add(n)

        const line = state.doc.line(n)
        const match = ATX_PREFIX.exec(line.text)
        if (!match) continue
        const indent = match[1] ?? ''
        const existing = match[2] ?? ''
        const currentLevel = existing.trimEnd().length

        const nextLevel = currentLevel === level ? 0 : level
        const insert = indent + (nextLevel > 0 ? `${'#'.repeat(nextLevel)} ` : '')
        const from = line.from
        const to = line.from + indent.length + existing.length
        if (state.sliceDoc(from, to) === insert) continue
        changes.push({ from, to, insert })
      }
    }

    if (changes.length === 0) return false
    dispatch(state.update({ changes, userEvent: 'input.typo.heading' }))
    return true
  }
}

function inList(state: Parameters<StateCommand>[0]['state'], pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent!) {
    if (node.name === BLOCK_NODES.listItem) return true
    if (!node.parent) return false
  }
  return false
}

/**
 * Tab：在列表里改变缩进层级，其他地方插入制表符。
 *
 * 已知简化：缩进按 indentUnit 走，不去对齐父列表标记的实际宽度。
 * 完整的 CommonMark 缩进对齐规则留给 M2 的列表打磨。
 */
export const indentListOrTab: Command = (view) => {
  const { state } = view
  const anyList = state.selection.ranges.some((r) => inList(state, r.head))
  if (anyList || state.selection.ranges.some((r) => !r.empty)) return indentMore(view)
  return insertTab(view)
}

export const dedentList: Command = (view) => indentLess(view)

export const toggleBold = toggleWrap('**')
export const toggleItalic = toggleWrap('*')
export const toggleInlineCode = toggleWrap('`')
export const toggleStrikethrough = toggleWrap('~~')

/** 光标所在行的标题层级，供状态栏/菜单显示当前状态。 */
export function currentHeadingLevel(state: Parameters<StateCommand>[0]['state']): number {
  const pos = state.selection.main.head
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent!) {
    const level = headingLevel(node.name)
    if (level > 0) return level
    if (!node.parent) return 0
  }
  return 0
}

/**
 * 回车续写列表 / 引用标记。
 *
 * `nonTightLists: false` 关掉上游默认的「在空列表项回车 → 插入空行、把列表变成
 * 松散列表」行为，改成「退出列表」—— 后者才是写作者按下回车时的预期
 * （docs/design/08-roadmap.md M2 明确要求）。
 */
export const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false })

export const typoKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleBold, preventDefault: true },
  { key: 'Mod-i', run: toggleItalic, preventDefault: true },
  { key: 'Mod-e', run: toggleInlineCode, preventDefault: true },
  { key: 'Mod-Shift-x', run: toggleStrikethrough, preventDefault: true },
  { key: 'Mod-0', run: setHeading(0), preventDefault: true },
  ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({
    key: `Mod-${level}`,
    run: setHeading(level),
    preventDefault: true,
  })),
  { key: 'Tab', run: indentListOrTab, shift: dedentList, preventDefault: true },
  { key: 'Enter', run: continueMarkup },
  { key: 'Backspace', run: deleteMarkupBackward },
]

/**
 * 键位与历史。
 *
 * 顺序有讲究：typoKeymap 在前，defaultKeymap 在后 —— 前者要能覆盖后者的
 * Enter / Backspace / Tab 默认行为。
 */
export function typoCommands(): Extension {
  return [
    history(),
    keymap.of([...typoKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
  ]
}
