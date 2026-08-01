/**
 * 编辑器外观（facade）。
 *
 * 宿主只跟这个类打交道，不直接碰 CodeMirror —— 这样将来替换内部实现、
 * 或者接第二个宿主（Web 版）时，接缝只有这一处。
 */
import { indentUnit, syntaxTree } from '@codemirror/language'
import { search } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  rectangularSelection,
} from '@codemirror/view'
import {
  countWords,
  extractOutline,
  markdownLanguageSupport,
  type MarkdownDialect,
  type OutlineItem,
} from '@typo/markdown'
import { codeBlockScrollSync } from './code-block.js'
import { currentHeadingLevel, typoCommands } from './commands.js'
import {
  livePreviewConfig,
  type AssetResolver,
  type ImageSink,
  type LivePreviewConfig,
} from './config.js'
import { imageInsertion } from './images.js'
import { inputBehavior } from './input.js'
import { linkInteraction } from './links.js'
import { livePreview } from './live-preview/index.js'
import { richTextPaste } from './paste.js'
import { typoTheme } from './theme.js'

export interface EditorStats {
  words: number
  characters: number
  lines: number
  /** 光标所在行（1-based）。 */
  line: number
  /** 光标所在列（1-based）。 */
  column: number
}

export interface EditorStatus {
  stats: EditorStats
  headingLevel: number
  sourceMode: boolean
}

export interface TypoEditorOptions {
  parent: HTMLElement
  doc?: string
  dialect?: MarkdownDialect
  assetResolver?: AssetResolver
  /** Ctrl/Cmd + 点击链接时调用，通常接到宿主的「用系统浏览器打开」。 */
  onOpenLink?: (url: string) => void
  /** 粘贴 / 拖入图片时把它存到哪儿。不传则关闭该功能。 */
  imageSink?: ImageSink
  /** 存图失败时的提示途径。 */
  onImageError?: (error: Error, name: string) => void
  sourceMode?: boolean
  readOnly?: boolean
  /** 文档内容变化时调用。频率等同于按键，实现方需自行控制开销。 */
  onDocChange?: (text: string) => void
  /** 状态变化（字数、光标位置）。已做 200ms 防抖。 */
  onStatus?: (status: EditorStatus) => void
}

const STATUS_DEBOUNCE_MS = 200

export class TypoEditor {
  readonly view: EditorView

  private readonly previewCompartment = new Compartment()
  private readonly configCompartment = new Compartment()
  private readonly readOnlyCompartment = new Compartment()
  private sourceModeOn: boolean
  private statusTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: TypoEditorOptions) {
    this.sourceModeOn = options.sourceMode ?? false

    this.view = new EditorView({
      parent: options.parent,
      state: EditorState.create({
        doc: options.doc ?? '',
        extensions: this.buildExtensions(),
      }),
    })
  }

  private buildExtensions(): Extension[] {
    const { options } = this
    return [
      // 方言默认值交给 @typo/markdown 决定（现为 GFM），这里不再写死一份 ——
      // 写死过一次，结果是「解析器默认换了、编辑器还在跑旧方言」
      markdownLanguageSupport(options.dialect ? { dialect: options.dialect } : {}),
      this.configCompartment.of(livePreviewConfig.of(this.previewConfig())),
      this.previewCompartment.of(this.sourceModeOn ? [] : livePreview()),
      linkInteraction(),
      this.readOnlyCompartment.of(EditorState.readOnly.of(options.readOnly ?? false)),
      typoTheme(),
      typoCommands(),
      inputBehavior(),
      imageInsertion(),
      richTextPaste(),
      codeBlockScrollSync(),
      search({ top: true }),
      // 正文必须自动折行 —— 这是散文编辑器，不是代码编辑器
      EditorView.lineWrapping,
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      highlightSpecialChars(),
      indentUnit.of('  '),
      // 多光标：CodeMirror 默认只保留一个选区，必须显式打开
      EditorState.allowMultipleSelections.of(true),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onDocChange?.(update.state.doc.toString())
        if (update.docChanged || update.selectionSet) this.scheduleStatus()
      }),
      EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Markdown 编辑区' }),
    ]
  }

  /**
   * 配置面的唯一来源。
   *
   * 抽出来是因为它有两个调用点（初始化与 setAssetResolver），
   * 而这个对象是**全量替换**的 —— 之前两处各写一份，加一个配置项就得记得
   * 改两处，漏掉一处的表现是「换了工作目录之后某个能力莫名失效」。
   */
  private previewConfig(resolver?: AssetResolver): Partial<LivePreviewConfig> {
    const { options } = this
    return {
      assetResolver: resolver ?? options.assetResolver ?? ((src) => src),
      renderImages: true,
      onOpenLink: options.onOpenLink ?? null,
      imageSink: options.imageSink ?? null,
      onImageError: options.onImageError ?? null,
    }
  }

  private scheduleStatus(): void {
    if (!this.options.onStatus) return
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.options.onStatus?.(this.status())
    }, STATUS_DEBOUNCE_MS)
  }

  status(): EditorStatus {
    const { state } = this.view
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    const { words, characters } = countWords(state.doc.toString())
    return {
      stats: {
        words,
        characters,
        lines: state.doc.lines,
        line: line.number,
        column: head - line.from + 1,
      },
      headingLevel: currentHeadingLevel(state),
      sourceMode: this.sourceModeOn,
    }
  }

  getDoc(): string {
    return this.view.state.doc.toString()
  }

  /**
   * 换一篇文档。
   *
   * 刻意重建整个 state：换文件就该换一条撤销栈，
   * 否则用户在 A 文件里按撤销会把 B 文件的内容倒出来。
   */
  setDoc(text: string, options: { readOnly?: boolean } = {}): void {
    if (options.readOnly !== undefined) this.options.readOnly = options.readOnly
    this.view.setState(EditorState.create({ doc: text, extensions: this.buildExtensions() }))
    this.options.onStatus?.(this.status())
  }

  /** 用一个 transaction 整体替换内容，保留撤销栈（用于「重新加载磁盘内容」）。 */
  replaceDoc(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      userEvent: 'input.typo.reload',
    })
  }

  setReadOnly(readOnly: boolean): void {
    this.view.dispatch({
      effects: this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }

  setAssetResolver(resolver: AssetResolver): void {
    this.view.dispatch({
      effects: this.configCompartment.reconfigure(
        livePreviewConfig.of(this.previewConfig(resolver)),
      ),
    })
  }

  isSourceMode(): boolean {
    return this.sourceModeOn
  }

  /** 源码模式 = 关掉实时预览扩展。文档本身一个字都不会变。 */
  setSourceMode(on: boolean): void {
    if (on === this.sourceModeOn) return
    this.sourceModeOn = on
    this.view.dispatch({
      effects: this.previewCompartment.reconfigure(on ? [] : livePreview()),
    })
    this.options.onStatus?.(this.status())
  }

  toggleSourceMode(): void {
    this.setSourceMode(!this.sourceModeOn)
  }

  outline(): OutlineItem[] {
    const { state } = this.view
    return extractOutline(syntaxTree(state), (from, to) => state.doc.sliceString(from, to))
  }

  focus(): void {
    this.view.focus()
  }

  /**
   * 把光标移到某个偏移并滚动过去（大纲跳转用）。
   *
   * `scrollIntoView` 用 `center` 而不是默认的最小滚动：从大纲点过去时，
   * 目标标题贴在视口边缘会让人以为没跳对。
   */
  jumpTo(pos: number): void {
    const clamped = Math.max(0, Math.min(pos, this.view.state.doc.length))
    this.view.dispatch({
      selection: { anchor: clamped },
      effects: EditorView.scrollIntoView(clamped, { y: 'center' }),
    })
    this.view.focus()
  }

  /** 光标当前偏移。 */
  cursor(): number {
    return this.view.state.selection.main.head
  }

  destroy(): void {
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.view.destroy()
  }
}
