/**
 * 测试辅助：把「装饰之后用户看到什么」变成一个字符串，方便直接断言。
 *
 * 这样测试读起来就是产品行为本身：
 *   expect(preview('**粗体**')).toBe('粗体')
 * 而不是一堆装饰对象的结构比对。
 */
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { markdownLanguageSupport, type MarkdownDialect } from '@typo/markdown'
import { computeDecorations, livePreviewConfig } from '@typo/editor'
import { BulletWidget, ImageWidget, RuleWidget } from '@typo/editor'

export interface StateOptions {
  /** 光标位置；数组表示多光标；[from, to] 元组表示选区。 */
  selection?: number | Array<number | [number, number]>
  dialect?: MarkdownDialect
  assetResolver?: (src: string) => string
  extensions?: Extension[]
}

export function mkState(doc: string, options: StateOptions = {}): EditorState {
  const ranges = (
    options.selection === undefined
      ? [0]
      : Array.isArray(options.selection)
        ? options.selection
        : [options.selection]
  ).map((s) =>
    Array.isArray(s) ? EditorSelection.range(s[0], s[1]) : EditorSelection.cursor(s),
  )

  const state = EditorState.create({
    doc,
    selection: EditorSelection.create(ranges),
    extensions: [
      markdownLanguageSupport({ dialect: options.dialect ?? 'commonmark' }),
      EditorState.allowMultipleSelections.of(true),
      livePreviewConfig.of({
        assetResolver: options.assetResolver ?? ((src) => src),
        renderImages: true,
      }),
      ...(options.extensions ?? []),
    ],
  })

  // 语法树是分批解析的；测试里必须确保解析完整，否则断言会随文档长度随机飘
  ensureSyntaxTree(state, state.doc.length, 10_000)
  return state
}

export function decorationsOf(state: EditorState) {
  return computeDecorations(state, [{ from: 0, to: state.doc.length }])
}

/**
 * 渲染出「用户看到的文本」。
 *
 * 被隐藏的源码消失；widget 用可读的占位符表示：
 *   •            无序列表符号
 *   ─            分隔线
 *   ⟦img:src|alt⟧  图片
 */
export function preview(doc: string, options: StateOptions = {}): string {
  // 没指定光标时，把光标停到一段无关的前导文字上。
  //
  // 不这么做的话默认光标落在偏移 0，会把第一行判定为激活 —— 那是**正确**的
  // 产品行为（刚打开文件时光标就在开头，首行显示源码），但会让「平时长什么样」
  // 这类断言全部测不到。前导段落后跟空行，不会影响后续块的解析。
  if (options.selection === undefined) {
    const rendered = renderPreview(PARK + doc, { ...options, selection: 0 })
    return rendered.slice(PARK.length)
  }
  return renderPreview(doc, options)
}

const PARK = '光标停在这里\n\n'

function renderPreview(doc: string, options: StateOptions): string {
  const state = mkState(doc, options)
  const { atomic } = decorationsOf(state)
  const text = state.doc.toString()

  let out = ''
  let pos = 0
  const iter = atomic.iter()
  while (iter.value) {
    out += text.slice(pos, iter.from)
    const widget = (iter.value.spec as { widget?: unknown }).widget
    if (widget instanceof BulletWidget) out += '•'
    else if (widget instanceof RuleWidget) out += '─'
    else if (widget instanceof ImageWidget) out += `⟦img:${widget.src}|${widget.alt}⟧`
    pos = iter.to
    iter.next()
  }
  return out + text.slice(pos)
}

/** 某个位置上覆盖的所有 mark 装饰类名。 */
export function classesAt(state: EditorState, pos: number): string[] {
  const { decorations } = decorationsOf(state)
  const found: string[] = []
  decorations.between(pos, pos + 1, (from, to, value) => {
    const cls = (value.spec as { class?: string }).class
    if (cls && from <= pos && to > pos) found.push(...cls.split(/\s+/))
  })
  return found
}

/** 某一行（1-based）上的行装饰类名。 */
export function lineClasses(state: EditorState, lineNumber: number): string[] {
  const { decorations } = decorationsOf(state)
  const line = state.doc.line(lineNumber)
  const found: string[] = []
  decorations.between(line.from, line.from, (from, to, value) => {
    const cls = (value.spec as { class?: string }).class
    if (cls && from === line.from && to === line.from) found.push(...cls.split(/\s+/))
  })
  return found
}

/** 被隐藏/替换掉的源码区间，用于检查重叠等结构性问题。 */
export function hiddenRanges(state: EditorState): Array<[number, number]> {
  const { atomic } = decorationsOf(state)
  const ranges: Array<[number, number]> = []
  const iter = atomic.iter()
  while (iter.value) {
    ranges.push([iter.from, iter.to])
    iter.next()
  }
  return ranges
}
