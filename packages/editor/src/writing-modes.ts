/**
 * 专注模式与打字机模式（docs/design/02 §8）。
 *
 * 两者都**不改文档一个字节**：专注模式是一层额外的行装饰，打字机模式只动
 * 滚动位置。它们放在同一个文件里是因为共享同一个前提 —— 「当前在写的是哪一块」。
 *
 * ## 为什么专注的单位是「块」而不是「行」
 *
 * 按行高亮在中文里几乎必错：一个自然段折行后有五六行，光标在第三行时另外五行
 * 变暗，读起来像文字被劈开了。按「块」算才对应人心里的「我正在写的这一段」。
 *
 * ## 为什么打字机模式不走 `dispatch`
 *
 * 直觉写法是在 updateListener 里 `dispatch(scrollIntoView(...))`，但 CodeMirror
 * 明确禁止在 update 期间再发 transaction，而且 `scrollIntoView` 只保证「可见」，
 * 到不了「居中」—— 目标行已经在视口里时它什么都不做，正是打字机模式最需要动的
 * 时候。所以这里走 `requestMeasure` 直接算 `scrollTop`：一次读、一次写，
 * 不产生任何 transaction，也就不会跟撤销栈、协作扩展互相干扰。
 */
import { syntaxTree } from '@codemirror/language'
import { Compartment, type EditorState, type Extension, type Range } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

/**
 * 「容器块」—— 遇到它们要继续往里走。
 *
 * 引用和列表本身不是「一段」：光标在列表第三项里时，把整个列表都点亮等于没做
 * 专注。往里走一层到 ListItem 就停，**不再往下走到 Paragraph** —— 再走一层
 * 项目符号就落在暗区里了，看着像列表少了一项。
 */
const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList'])

/** 变暗的行的类名。宿主主题通过 `--mosu-focus-dim` 调不透明度。 */
export const DIM_CLASS = 'cm-mosu-dim'

const dimLine = Decoration.line({ class: DIM_CLASS })

/**
 * 光标所在的那一块的范围。
 *
 * 落在块之间的空行上时 `resolveInner` 只能给到 Document，此时退回**当前行** ——
 * 而不是「整篇都算当前块」。后者的表现是「光标一进空行，全文突然全亮」，
 * 像是功能坏了。
 */
export function focusRangeAt(state: EditorState, pos: number): { from: number; to: number } {
  const chain: SyntaxNode[] = []
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    chain.unshift(node)
  }

  let i = 0
  while (i + 1 < chain.length && CONTAINERS.has((chain[i] as SyntaxNode).name)) i++

  const node = chain[i]
  if (!node || CONTAINERS.has(node.name)) {
    const line = state.doc.lineAt(pos)
    return { from: line.from, to: line.to }
  }
  return { from: node.from, to: node.to }
}

/**
 * 给定范围内、不属于当前块的那些行。
 *
 * 签名跟 `computeDecorations(state, ranges)` 一致，而不是收一个 EditorView ——
 * 这样它是个纯函数，测试不需要 DOM 就能断言「哪几行变暗了」。
 *
 * 调用方只传**可见范围**是刻意的：这层装饰在每次光标移动时重建，若按全文算，
 * 一篇五万行的文档每按一下方向键就要生成五万个装饰。可见范围是几十行量级，
 * 而看不见的行变不变暗，没有人能观察到。
 */
export function computeDimDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const focus = focusRangeAt(state, state.selection.main.head)
  // 按半开区间算终点：列表项一类的节点 `to` 会盖过行尾的换行符，落在下一行
  // 的行首上。照闭区间判断的话，当前项的下一行也会被点亮 ——
  // 看起来像专注模式「多亮了一行」，而这一行还会随节点类型时有时无
  const end = focus.to > focus.from ? focus.to - 1 : focus.to
  const marks: Range<Decoration>[] = []

  for (const { from, to } of ranges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos)
      const inside = line.from <= end && line.to >= focus.from
      if (!inside) marks.push(dimLine.range(line.from))
      pos = line.to + 1
    }
  }
  return Decoration.set(marks)
}

/** 专注模式：当前块以外的行变暗。 */
export function focusMode(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = computeDimDecorations(view.state, view.visibleRanges)
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = computeDimDecorations(update.view.state, update.view.visibleRanges)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}

/**
 * 把光标所在行滚到视口垂直中央。
 *
 * 用 `requestMeasure` 而不是 `scrollIntoView`，理由见文件头。读阶段全部用
 * **视口坐标**算，不去猜 `.cm-content` 的 padding 怎么计入块坐标 —— 打字机
 * 模式恰恰要往 content 上加 50vh 的 padding，猜错的表现是「越靠近文档开头
 * 偏得越多」，很难一眼看出是坐标系的问题。
 */
function recenter(view: EditorView): void {
  view.requestMeasure({
    read(v) {
      const block = v.lineBlockAt(v.state.selection.main.head)
      const scroller = v.scrollDOM
      const top = v.documentTop + block.top
      const wanted =
        scroller.getBoundingClientRect().top + scroller.clientHeight / 2 - block.height / 2
      return scroller.scrollTop + (top - wanted)
    },
    write(target, v) {
      // 浏览器自己会把越界值夹回去，这里不重复夹一遍
      v.scrollDOM.scrollTop = target
    },
  })
}

/**
 * 打字机模式：当前行常驻视口中央。
 *
 * 两条克制的规则，都是为了不跟用户抢滚动条：
 *
 * 1. **只在光标是插入点（没有选区）时居中。** 鼠标拖选必然产生选区，
 *    此时每动一下就把视图拽回中间，选不到东西。全选同理。
 * 2. **只在行号变化时居中。** 在同一行里左右移动光标不该引发滚动 ——
 *    那既没必要，也会让「行高不一致时反复微调」变成可见的抖动。
 */
export function typewriterMode(): Extension {
  return ViewPlugin.fromClass(
    class {
      private line: number

      constructor(private readonly view: EditorView) {
        this.line = lineOf(view.state)
        recenter(view)
      }

      update(update: ViewUpdate) {
        if (!update.docChanged && !update.selectionSet) return
        if (!update.state.selection.main.empty) return
        const line = lineOf(update.state)
        // 文档变了但行号没变（在同一行里打字）也要重新居中：
        // 折行会让这一行长高，中心跟着往下走
        if (line === this.line && !update.docChanged) return
        this.line = line
        recenter(this.view)
      }
    },
  )
}

function lineOf(state: EditorState): number {
  return state.doc.lineAt(state.selection.main.head).number
}

/** 打字机模式给编辑器根元素挂的类名。主题也可以拿它做别的区分。 */
export const TYPEWRITER_CLASS = 'cm-mosu-typewriter'

/**
 * 打字机模式要的上下留白。
 *
 * 没有它，第一行和最后一行永远到不了中央 —— 滚动条已经到头了。50vh 是刚好
 * 够用的量：正好让文档的第一个字符能停在正中间。
 *
 * **必须靠根元素上的类名提高优先级**，不能直接写 `.cm-content { padding-top }`：
 * 基础主题里那条是 `padding` 简写，跟它同优先级时谁后进样式表谁赢，而顺序取决
 * 于扩展的注册次序 —— 表现是「打字机模式看着开了，但第一行怎么也到不了中间」，
 * 而且换个扩展顺序就会自己好，非常难查。
 */
export function typewriterPadding(): Extension {
  return [
    EditorView.editorAttributes.of({ class: TYPEWRITER_CLASS }),
    EditorView.theme({
      [`&.${TYPEWRITER_CLASS} .cm-content`]: { paddingTop: '50vh', paddingBottom: '50vh' },
    }),
  ]
}

/**
 * 两个模式的可切换封装。
 *
 * 用 Compartment 而不是「装上去之后靠一个 Facet 开关」：关掉时扩展要**真的
 * 卸载**，否则专注模式的 ViewPlugin 即使不产生装饰，也仍然在每次光标移动时
 * 遍历一遍可见行。
 */
export class WritingModes {
  private readonly focusCompartment = new Compartment()
  private readonly typewriterCompartment = new Compartment()

  constructor(
    private focusOn = false,
    private typewriterOn = false,
  ) {}

  extension(): Extension {
    return [
      this.focusCompartment.of(this.focusOn ? focusMode() : []),
      this.typewriterCompartment.of(this.typewriterOn ? typewriterExtension() : []),
    ]
  }

  isFocus(): boolean {
    return this.focusOn
  }

  isTypewriter(): boolean {
    return this.typewriterOn
  }

  setFocus(view: EditorView, on: boolean): void {
    if (on === this.focusOn) return
    this.focusOn = on
    view.dispatch({ effects: this.focusCompartment.reconfigure(on ? focusMode() : []) })
  }

  setTypewriter(view: EditorView, on: boolean): void {
    if (on === this.typewriterOn) return
    this.typewriterOn = on
    view.dispatch({
      effects: this.typewriterCompartment.reconfigure(on ? typewriterExtension() : []),
    })
  }
}

function typewriterExtension(): Extension {
  return [typewriterPadding(), typewriterMode()]
}
