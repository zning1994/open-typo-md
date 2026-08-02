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
import {
  EditorSelection,
  type EditorState,
  type Extension,
  type SelectionRange,
  type StateCommand,
} from '@codemirror/state'
import { keymap, type Command, type KeyBinding } from '@codemirror/view'
import { BLOCK_NODES, headingLevel } from '@mosu/markdown'
import { tableNextCell, tableNextRow, tablePrevCell } from './table-edit.js'

/**
 * 把选区往里收，直到两端都不是空白。
 *
 * 强调标记的两侧不能有空白，这是 CommonMark 的 flanking 规则（spec 例 379、391）：
 * `** foo bar**` 和 `**foo bar **` 都按**字面**渲染。所以「选中 `def ` 按 Cmd-B」
 * 产出的 `abc **def **ghi` 不是「加粗了但多个空格」，而是**根本没有加粗**，
 * 用户文件里凭空多了四个星号（issue #9a）。
 *
 * 跨行选区是同一件事的另一种形态，而且常见得多：「选中一整行再 Cmd-B」时
 * 选区末尾带着那个换行符，于是闭合标记落到了下一行的行首 ——
 * `**para one\n**para two`。换行符也是空白，挤出去就对了。
 */
function squeeze(state: EditorState, range: SelectionRange): SelectionRange {
  let { from, to } = range
  while (from < to && /\s/.test(state.sliceDoc(from, from + 1))) from++
  while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--
  // 选中的全是空白：塌回选区**起点**而不是终点。落在终点的话，
  // 用户选了两个空格按 Cmd-B，标记会跑到空白的另一边去，看着像是选错了
  return from === to ? EditorSelection.cursor(range.from) : EditorSelection.range(from, to)
}

/**
 * 紧邻选区的这串 marker 里，包不包含**这一层**强调。
 *
 * 只比长度是不够的（issue #9c 的教训还差一半）：`*` 与 `**` 会叠在一起，
 * 而 CommonMark 是按**总数**拆的 —— `***x***` 是粗体加斜体。所以：
 *
 * | 串长 | 含义 | 按斜体 | 按加粗 |
 * | --- | --- | --- | --- |
 * | `*` | 斜体 | 脱掉 → `x` | 再包 → `***x***` |
 * | `**` | 粗体 | **再包** → `***x***` | 脱掉 → `x` |
 * | `***` | 粗体 + 斜体 | 脱掉一层 → `**x**` | 脱掉两个 → `*x*` |
 *
 * 中间那一行就是报告里的现场：把它当成「一个斜体标记」去脱，粗体就没了。
 *
 * `~~` 和 `` ` `` 不叠，按长度判断就够。
 */
function hasLayer(run: number, len: number, ch: string): boolean {
  if (ch !== '*' && ch !== '_') return run >= len
  // 斜体占一个，所以看奇偶；粗体占两个，有两个以上就一定含它
  return len === 1 ? run % 2 === 1 : run >= len
}

/** `pos` 紧邻**左侧**连续出现了几个 `ch`。 */
function runBefore(state: EditorState, pos: number, ch: string): number {
  let n = 0
  while (pos - n > 0 && state.sliceDoc(pos - n - 1, pos - n) === ch) n++
  return n
}

/** `pos` 紧邻**右侧**连续出现了几个 `ch`。 */
function runAfter(state: EditorState, pos: number, ch: string): number {
  let n = 0
  const end = state.doc.length
  while (pos + n < end && state.sliceDoc(pos + n, pos + n + 1) === ch) n++
  return n
}

/**
 * 行内代码的围栏。
 *
 * CommonMark 要求围栏的反引号数**多于**内容里最长的那串，否则内容里的反引号
 * 会提前把 code span 闭掉。原来一律用一个反引号，于是选中 `a` + 反引号 + `b`
 * 按 Ctrl+E 得到的东西只有开头那个 `a` 成了代码，后面还剩一个游离的反引号
 * （issue #9b）。语义变了，不只是难看。
 *
 * 内容以反引号开头或结尾时还要各垫一个空格：`` ` `` + `` `a` `` 挨在一起
 * 同样会被算进围栏。这两个空格在渲染时会被剥掉，不会进到代码内容里。
 */
function codeFence(content: string): { fence: string; pad: string } {
  let longest = 0
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return {
    fence: '`'.repeat(longest + 1),
    pad: content.startsWith('`') || content.endsWith('`') ? ' ' : '',
  }
}

/**
 * 用成对标记包裹选区；已经被包裹则解包。
 *
 * 解包时刻意只看紧邻选区的字符，而不去查语法树 —— 用户选中 `粗体` 两个字
 * 按 Ctrl+B，期望的是把外面那对 `**` 去掉，而不是把整个段落的强调结构重算。
 *
 * 但「只看一个字符」曾经不够（issue #9c）：对 `这是**重点**内容` 里的「重点」
 * 按 Ctrl+I 时，`*` 的左右各看一个字符都是 `*`，看起来正像一对斜体标记，
 * 于是**把粗体的内侧星号拆走了** —— 用户按下「斜体」，得到的是粗体没了。
 *
 * 判据改成看整条 marker 串、按 CommonMark 的叠加规则拆（见 `hasLayer`）。
 * 于是 `**重点**` 按斜体得到 `***重点***`，跟直接敲 `*` 的行为对上了
 * （input.ts 的 wrapSelection 没有解包分支，一直给的就是这个结果）。
 */
export function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const len = marker.length
    const ch = marker[0] as string
    const isCode = ch === '`'

    const tr = state.changeByRange((raw) => {
      const range = raw.empty ? raw : squeeze(state, raw)
      // 整段全是空白：当成没选东西，退回「在光标处插入一对标记」
      const empty = range.from === range.to

      // 解包的条件：两侧的 marker 串里确实含着**这一层**强调
      if (
        !empty &&
        hasLayer(runBefore(state, range.from, ch), len, ch) &&
        hasLayer(runAfter(state, range.to, ch), len, ch)
      ) {
        return {
          changes: [
            { from: range.from - len, to: range.from },
            { from: range.to, to: range.to + len },
          ],
          range: EditorSelection.range(range.from - len, range.to - len),
        }
      }

      const content = state.sliceDoc(range.from, range.to)
      const { fence, pad } = isCode ? codeFence(content) : { fence: marker, pad: '' }
      const open = fence + pad
      const close = pad + fence

      return {
        changes: [
          { from: range.from, insert: open },
          { from: range.to, insert: close },
        ],
        range: empty
          ? EditorSelection.cursor(range.from + open.length)
          : EditorSelection.range(range.from + open.length, range.to + open.length),
      }
    })
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.mosu.wrap' }))
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
    dispatch(state.update({ changes, userEvent: 'input.mosu.heading' }))
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

/**
 * 依次尝试，第一个返回 true 的胜出。
 *
 * 表格命令必须排在通用命令**前面**：表格里的 Tab 是「下一个单元格」，
 * 而落到 `indentListOrTab` 会往表头行里插一个制表符，表格当场散架。
 */
function chain(...commands: Command[]): Command {
  return (view) => commands.some((command) => command(view))
}

/**
 * 可以被重新绑定的格式命令。
 *
 * id 是内核自己的命名（`bold`、`heading3`），**不是宿主那套** ——
 * 编辑器内核不认识 `format.bold` 这种菜单命令名（原则 P3）。
 * 宿主负责把两边对起来。
 */
export const FORMAT_COMMANDS: Record<string, Command> = {
  bold: toggleBold,
  italic: toggleItalic,
  code: toggleInlineCode,
  strikethrough: toggleStrikethrough,
  ...Object.fromEntries(
    ([0, 1, 2, 3, 4, 5, 6] as const).map((level) => [`heading${level}`, setHeading(level)]),
  ),
}

/** 出厂键位。宿主可以整份换掉，见 `mosuCommands`。 */
export const DEFAULT_FORMAT_KEYS: Record<string, string> = {
  bold: 'Mod-b',
  italic: 'Mod-i',
  code: 'Mod-e',
  strikethrough: 'Mod-Shift-x',
  ...Object.fromEntries(
    ([0, 1, 2, 3, 4, 5, 6] as const).map((level) => [`heading${level}`, `Mod-${level}`]),
  ),
}

/**
 * 结构性键位：Tab / Enter / Backspace。
 *
 * **刻意不可配置。** 它们不是「某个功能的快捷键」，而是编辑行为本身 ——
 * 表格里的 Tab 是「下一个单元格」，列表里的 Enter 是「续写标记」。
 * 让用户把 Enter 改掉，等于让他把换行改掉。
 */
export const structuralKeymap: KeyBinding[] = [
  {
    key: 'Tab',
    run: chain(tableNextCell, indentListOrTab),
    shift: chain(tablePrevCell, dedentList),
    preventDefault: true,
  },
  { key: 'Enter', run: chain(tableNextRow, continueMarkup) },
  { key: 'Backspace', run: deleteMarkupBackward },
]

/** 把「命令 id → 键位」的表变成 CodeMirror 的 keymap。 */
export function formatKeymap(keys: Record<string, string>): KeyBinding[] {
  const bindings: KeyBinding[] = []
  for (const [id, key] of Object.entries(keys)) {
    const run = FORMAT_COMMANDS[id]
    // 认不出来的 id 直接跳过：宿主与内核的命令表可能不同版本，
    // 为此让整个键位表失效是最糟的降级
    if (run && key) bindings.push({ key, run, preventDefault: true })
  }
  return bindings
}

export const mosuKeymap: KeyBinding[] = [
  ...formatKeymap(DEFAULT_FORMAT_KEYS),
  ...structuralKeymap,
]

/**
 * 键位与历史。
 *
 * 顺序有讲究：格式与结构键位在前，defaultKeymap 在后 —— 前者要能覆盖后者的
 * Enter / Backspace / Tab 默认行为。
 */
export function mosuCommands(
  formatKeys: Record<string, string> = DEFAULT_FORMAT_KEYS,
): Extension {
  return [
    history(),
    keymap.of([
      ...formatKeymap(formatKeys),
      ...structuralKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
  ]
}
