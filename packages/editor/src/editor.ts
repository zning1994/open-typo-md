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
} from '@mosu/markdown'
import { codeBlockScrollSync } from './code-block.js'
import { DEFAULT_FORMAT_KEYS, currentHeadingLevel, mosuCommands } from './commands.js'
import {
  DEFAULT_LABELS,
  livePreviewConfig,
  type AssetResolver,
  type EditorLabels,
  type ImageSink,
  type LivePreviewConfig,
} from './config.js'
import { imageInsertion } from './images.js'
import { inputBehavior } from './input.js'
import { linkInteraction } from './links.js'
import { livePreview } from './live-preview/index.js'
import { richTextPaste } from './paste.js'
import { mosuTheme } from './theme.js'
import { WritingModes } from './writing-modes.js'

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
  focusMode: boolean
  typewriterMode: boolean
}

export interface MosuEditorOptions {
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
  /** 专注模式：当前块以外的内容变暗。 */
  focusMode?: boolean
  /** 打字机模式：当前行常驻视口中央。 */
  typewriterMode?: boolean
  /** 渲染文档里的行内 HTML。默认开，见 config.ts 的 `renderInlineHtml`。 */
  renderInlineHtml?: boolean
  /** 编辑区里那几条给人看的文字。不传就用英文默认值，见 `EditorLabels`。 */
  labels?: EditorLabels
  /**
   * 格式命令的键位（`{ bold: 'Mod-b', … }`）。不传就用出厂键位。
   *
   * 宿主要让用户改快捷键时，把整份换掉 —— **不是合并**。合并的话用户
   * 「把加粗从 ⌘B 挪到 ⌘⇧B」会得到两个都能用的绑定，旧的那个还赖着不走。
   */
  formatKeys?: Record<string, string>
  readOnly?: boolean
  /** 文档内容变化时调用。频率等同于按键，实现方需自行控制开销。 */
  onDocChange?: (text: string) => void
  /** 状态变化（字数、光标位置）。已做 200ms 防抖。 */
  onStatus?: (status: EditorStatus) => void
}

const STATUS_DEBOUNCE_MS = 200

export class MosuEditor {
  readonly view: EditorView

  private readonly previewCompartment = new Compartment()
  private readonly configCompartment = new Compartment()
  private readonly readOnlyCompartment = new Compartment()
  private readonly keymapCompartment = new Compartment()
  private readonly labelCompartment = new Compartment()
  private sourceModeOn: boolean
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 配置面里**可变**的那两项。
   *
   * 放在字段上而不是每次从 options 读：它们能被 setAssetResolver /
   * setRenderInlineHtml 改，而配置面是全量替换的 —— 只带上其中一项去
   * reconfigure，另一项就被悄悄退回默认值了。
   */
  private resolverOverride: AssetResolver | null = null
  private renderInlineHtmlOn: boolean
  private formatKeys: Record<string, string>
  private labels: EditorLabels
  /**
   * 书写模式（专注 / 打字机）。
   *
   * 存成字段而不是每次从 options 读，理由跟上面那两项一样：它们能被 set*
   * 改，而 `setDoc` 会用 `buildExtensions()` 重建整个 state —— 从 options
   * 读的话，换一篇文档就把用户开着的专注模式悄悄关掉了。
   */
  private readonly modes: WritingModes

  constructor(private readonly options: MosuEditorOptions) {
    this.sourceModeOn = options.sourceMode ?? false
    this.renderInlineHtmlOn = options.renderInlineHtml ?? true
    this.formatKeys = options.formatKeys ?? DEFAULT_FORMAT_KEYS
    this.labels = options.labels ?? DEFAULT_LABELS
    this.modes = new WritingModes(options.focusMode ?? false, options.typewriterMode ?? false)

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
      // 方言默认值交给 @mosu/markdown 决定（现为 GFM），这里不再写死一份 ——
      // 写死过一次，结果是「解析器默认换了、编辑器还在跑旧方言」
      markdownLanguageSupport(options.dialect ? { dialect: options.dialect } : {}),
      this.configCompartment.of(livePreviewConfig.of(this.previewConfig())),
      this.previewCompartment.of(this.sourceModeOn ? [] : livePreview()),
      this.modes.extension(),
      linkInteraction(),
      this.readOnlyCompartment.of(EditorState.readOnly.of(options.readOnly ?? false)),
      mosuTheme(),
      this.keymapCompartment.of(mosuCommands(this.formatKeys)),
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
      // aria-label 走 compartment：它是**唯一**一条不在配置面里、却要随语言变的
      // 文案。放进配置面也不行 —— contentAttributes 只在扩展重配时才重新读
      this.labelCompartment.of(this.contentAttributes()),
    ]
  }

  /**
   * 配置面的唯一来源。
   *
   * 抽出来是因为它有两个调用点（初始化与 setAssetResolver），
   * 而这个对象是**全量替换**的 —— 之前两处各写一份，加一个配置项就得记得
   * 改两处，漏掉一处的表现是「换了工作目录之后某个能力莫名失效」。
   */
  private previewConfig(): Partial<LivePreviewConfig> {
    const { options } = this
    return {
      assetResolver: this.resolverOverride ?? options.assetResolver ?? ((src) => src),
      renderImages: true,
      renderInlineHtml: this.renderInlineHtmlOn,
      labels: this.labels,
      onOpenLink: options.onOpenLink ?? null,
      imageSink: options.imageSink ?? null,
      onImageError: options.onImageError ?? null,
    }
  }

  /** 把配置面重新推给编辑器。改任何一项可变配置都走这里。 */
  private reconfigure(): void {
    this.view.dispatch({
      effects: this.configCompartment.reconfigure(livePreviewConfig.of(this.previewConfig())),
    })
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
      focusMode: this.modes.isFocus(),
      typewriterMode: this.modes.isTypewriter(),
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
      userEvent: 'input.mosu.reload',
    })
  }

  setReadOnly(readOnly: boolean): void {
    this.view.dispatch({
      effects: this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }

  setAssetResolver(resolver: AssetResolver): void {
    this.resolverOverride = resolver
    this.reconfigure()
  }

  private contentAttributes(): Extension {
    return EditorView.contentAttributes.of({
      spellcheck: 'true',
      'aria-label': this.labels.editor,
    })
  }

  /** 换掉编辑区里那几条可见文字（宿主换界面语言时调用）。整份替换。 */
  setLabels(labels: EditorLabels): void {
    this.labels = labels
    this.view.dispatch({
      effects: [
        this.configCompartment.reconfigure(livePreviewConfig.of(this.previewConfig())),
        this.labelCompartment.reconfigure(this.contentAttributes()),
      ],
    })
  }

  /** 换掉格式命令的键位。整份替换，见 `MosuEditorOptions.formatKeys`。 */
  setFormatKeys(keys: Record<string, string>): void {
    this.formatKeys = keys
    this.view.dispatch({
      effects: this.keymapCompartment.reconfigure(mosuCommands(keys)),
    })
  }

  /** 开关行内 HTML 的渲染。关掉之后文档里的 `<b>` 按原文显示。 */
  setRenderInlineHtml(on: boolean): void {
    if (on === this.renderInlineHtmlOn) return
    this.renderInlineHtmlOn = on
    this.reconfigure()
  }

  isSourceMode(): boolean {
    return this.sourceModeOn
  }

  isFocusMode(): boolean {
    return this.modes.isFocus()
  }

  isTypewriterMode(): boolean {
    return this.modes.isTypewriter()
  }

  /**
   * 专注模式与源码模式**互不排斥** —— 源码模式下变暗依然成立，
   * 而且照样按块算（语法树在源码模式下也还在）。
   */
  setFocusMode(on: boolean): void {
    if (on === this.modes.isFocus()) return
    this.modes.setFocus(this.view, on)
    this.options.onStatus?.(this.status())
  }

  setTypewriterMode(on: boolean): void {
    if (on === this.modes.isTypewriter()) return
    this.modes.setTypewriter(this.view, on)
    this.options.onStatus?.(this.status())
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
