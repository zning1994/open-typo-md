/**
 * 输入行为：自动配对与选中包裹（docs/design/02 §7）。
 *
 * ## 一条分界线
 *
 * 「自动配对」在散文编辑器里必须比在代码编辑器里克制得多，因为 Markdown 的
 * 强调标记（`*` `_` `~`）**同时也是普通标点和列表标记**。分成两类处理：
 *
 * | 类别 | 字符 | 空选区时 | 有选区时 |
 * | --- | --- | --- | --- |
 * | 括号类 | `(` `[` `{` `"` | 自动补右半边 | 包裹 |
 * | 强调类 | `*` `_` `~` `` ` `` | **原样插入** | 包裹 |
 *
 * 强调类在空选区时绝不自动补全。行首敲 `*` 是在起一个列表项，补成 `**`
 * 会让人当场想砸键盘；`_` 出现在标识符里（`some_var`）；`~` 在路径里
 * （`~/文档`）。这类误伤的代价远高于「少补一个字符」的收益。
 *
 * 反引号是个例外：它归在强调类里（不自动配对），因为 ``` ``` ``` 围栏是
 * 连着敲三个反引号，自动配对会插出一堆多余的反引号。
 *
 * ## 为什么不直接用 closeBrackets 的 before 配置
 *
 * 上游的 `closeBrackets()` 对**所有**配置的字符一视同仁地在空选区时补全，
 * 没有「只包裹、不补全」这档。所以强调类由本文件自己处理，
 * 括号类交给上游 —— 后者还顺带处理了「补出来的右括号再敲一次会跳过去」
 * 这类细节，重写一遍不划算。
 */
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { isCodeContext } from '@typo/markdown'

/**
 * 只包裹、不补全的字符。
 *
 * 值是「包裹时用的完整标记」—— 敲一次 `*` 得到的是斜体 `*x*`，
 * 敲两次自然就成了粗体 `**x**`（第二次作用在已经被选中的 `*x*` 上）。
 * 不搞「敲一次直接变粗体」的特殊处理：那样就没法打出斜体了。
 */
const WRAPPERS = new Map<string, string>([
  ['*', '*'],
  ['_', '_'],
  ['~', '~'],
  ['`', '`'],
])

/** 光标处于代码上下文中 —— 代码里的 `*` 就是 `*`，不做任何包裹。 */
function inCodeContext(state: EditorState, pos: number): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (isCodeContext(node.name)) return true
  }
  return false
}

/**
 * 选中文字后敲强调字符 → 包裹。
 *
 * 走 `inputHandler` 而不是 keymap：keymap 认的是**按键**，而 `*` 在不同键盘
 * 布局上位置不同，输入法状态下更是对不上。inputHandler 认的是**最终插入的
 * 字符**，这才是我们真正关心的东西。
 */
const wrapSelection = EditorView.inputHandler.of((view, from, to, text) => {
  const marker = WRAPPERS.get(text)
  if (!marker) return false

  const { state } = view
  // 只在「确实选中了东西」时接管；空选区一律放行，走默认插入
  if (state.selection.ranges.every((r) => r.empty)) return false
  // 输入法组合中不插手，避免把候选文字包进标记里
  if (view.composing) return false
  if (state.selection.ranges.some((r) => inCodeContext(state, r.from))) return false

  // from/to 是本次输入要替换掉的范围。它跟主选区不一致时说明是别的输入路径
  // （拖放、补全等），交还给默认行为，不猜
  const main = state.selection.main
  if (from !== main.from || to !== main.to) return false

  view.dispatch(
    state.changeByRange((range) => {
      if (range.empty) {
        return {
          changes: { from: range.from, insert: text },
          range: EditorSelection.cursor(range.from + text.length),
        }
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        // 保持选中包裹后的内容，这样连敲两次就是加粗
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
      }
    }),
    { scrollIntoView: true, userEvent: 'input.typo.wrap' },
  )
  return true
})

/**
 * 括号类的配置。
 *
 * 上游默认集是 `( [ { ' "`。**单引号必须去掉** —— 英文正文里它是撇号
 * （don't、it's），自动配对会把每一个缩写都变成 `don''t`。
 * 这是散文编辑器和代码编辑器最典型的一处分歧。
 *
 * 走 languageData 而不是直接传参：代码块内部由嵌套语言自己提供配置，
 * 那里 `'` 该配对就配对，两不相干。
 */
const bracketConfig = EditorState.languageData.of(() => [
  { closeBrackets: { brackets: ['(', '[', '{', '"'] } },
])

export function inputBehavior(): Extension {
  return [
    bracketConfig,
    // 两者管的字符集互不相交（强调类 vs 括号类），谁先谁后都一样，
    // 不需要 Prec 调优先级
    wrapSelection,
    // 括号类交给上游：它还处理了「右括号再敲一次跳过去」「退格删掉整对」这些细节
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
  ]
}
