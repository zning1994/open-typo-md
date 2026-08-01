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
import { computeBlockDecorations, computeDecorations, livePreviewConfig } from '@typo/editor'
import {
  BulletWidget,
  EntityWidget,
  ImageWidget,
  RuleWidget,
  TaskCheckboxWidget,
} from '@typo/editor'

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
      // 默认跟产品一致（GFM）。CommonMark 严格模式要在用例里显式指定，
      // 免得测试悄悄跑在一个用户永远碰不到的方言上。
      markdownLanguageSupport({ dialect: options.dialect ?? 'gfm' }),
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
 *   ☐ / ☑        任务列表复选框
 *   ⟦img:src|alt⟧  图片
 *   实体直接显示解码后的字符
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
  const text = state.doc.toString()

  let out = ''
  let pos = 0
  for (const [from, to, widget] of replacedRanges(state)) {
    // 块级隐藏往前吃掉一个换行符（见 blocks.ts），行内装饰不会。
    // 两者互不重叠，但拼接时得从上一段的结尾接着切，不能倒退
    if (from < pos) continue
    out += text.slice(pos, from)
    if (widget instanceof BulletWidget) out += '•'
    else if (widget instanceof RuleWidget) out += '─'
    else if (widget instanceof TaskCheckboxWidget) out += widget.checked ? '☑' : '☐'
    else if (widget instanceof EntityWidget) out += widget.text
    else if (widget instanceof ImageWidget) out += `⟦img:${widget.src}|${widget.alt}⟧`
    pos = to
  }
  return out + text.slice(pos)
}

/**
 * 全部「被替换掉的源码区间」，行内（ViewPlugin）与块级（StateField）合在一起。
 *
 * 两条通路必须一起看，否则表格分隔行、代码围栏这些块级隐藏在 preview() 里
 * 会凭空出现 —— 那正是最容易看走眼的地方。
 */
function replacedRanges(state: EditorState): Array<[number, number, unknown]> {
  const found: Array<[number, number, unknown]> = []

  const collect = (set: ReturnType<typeof computeBlockDecorations>): void => {
    const iter = set.iter()
    while (iter.value) {
      // 行装饰（语言角标之类）不替换任何东西，跳过
      if (iter.to > iter.from || (iter.value.spec as { widget?: unknown }).widget) {
        found.push([iter.from, iter.to, (iter.value.spec as { widget?: unknown }).widget])
      }
      iter.next()
    }
  }

  collect(decorationsOf(state).atomic)
  collect(computeBlockDecorations(state))
  return found.sort((a, b) => a[0] - b[0] || a[1] - b[1])
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
