/**
 * 渲染进程入口：把标签页、编辑器、文档控制器、外壳 UI 接起来。
 *
 * 形态见 docs/adr/0005：窗口装载，标签持有状态。这个文件本身**不持有任何
 * 文档状态** —— 它只负责把「当前活动标签」的状态投影到状态栏、标题、菜单上。
 * 早先这里存着 `currentPath`，多标签下那必然会跟某个标签的真实路径不同步。
 */
import { openSearchPanel } from '@codemirror/search'
import type { StateCommand } from '@codemirror/state'
import {
  MosuEditor,
  renderMermaid,
  setHeading,
  tableAlignColumn,
  tableDeleteColumn,
  tableDeleteRow,
  tableFormat,
  tableInsert,
  tableInsertColumnAfter,
  tableInsertColumnBefore,
  tableInsertRowAbove,
  tableInsertRowBelow,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  type EditorLabels,
  type EditorStatus,
} from '@mosu/editor'
import type { MenuCommand } from '../shared/channels.js'
import { menuCommandTitle, type Command } from './commands.js'
import { DocumentController } from './document.js'
import { FileTreePanel } from './filetree.js'
import { OutlinePanel } from './outline.js'
import { CommandPalette } from './palette.js'
import { PreferenceStore } from './preferences.js'
import { applyLanguage, t } from './i18n.js'
import { LANGUAGE_KEY, isLanguageSetting, type LanguageSetting } from '../shared/i18n.js'
import { EDITOR_FORMAT_IDS, KeybindingStore } from './keybindings.js'
import { toCodeMirrorKey } from '../shared/keys.js'
import { SettingsPanel } from './settings-panel.js'
import { TabManager } from './tabs.js'
import { ThemeManager, THEMES } from './theme.js'
import {
  buildAssetUrl,
  createAssetResolver,
  createHostBridge,
  dirnameOf,
  getBridgeApi,
} from './host.js'
import {
  exportHtmlDocument,
  exportHtmlFragment,
  exportPdfHtml,
  type ExportContext,
} from './export.js'
import './styles.css'

const api = getBridgeApi()
const host = createHostBridge()

function require$<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (!found) throw new Error(`页面结构不完整，缺少 ${selector}`)
  return found
}

const workspace = require$<HTMLElement>('#workspace')
const editorHost = require$<HTMLElement>('#editor')
const tabStrip = require$<HTMLElement>('#tab-bar')
const statusName = require$<HTMLElement>('#status-name')
const statusMeta = require$<HTMLElement>('#status-meta')
const statusStats = require$<HTMLElement>('#status-stats')
const statusMode = require$<HTMLButtonElement>('#status-mode')
const statusFocus = require$<HTMLButtonElement>('#status-focus')
const statusTypewriter = require$<HTMLButtonElement>('#status-typewriter')

/**
 * 状态栏上那两个模式开关。
 *
 * 真相取自**偏好**而不是当前编辑器：它们是全局模式，而 `onStatus` 只在活动
 * 标签变化时才触发 —— 从偏好读的话，哪怕开关是在设置面板里点的，状态栏也
 * 立刻跟上。
 */
/** 把编辑器状态投影到状态栏。抽出来是为了换语言时能重放一次。 */
function applyStatus(status: EditorStatus): void {
  statusStats.textContent = t('status.stats', {
    words: status.stats.words,
    line: status.stats.line,
    column: status.stats.column,
  })
  statusMode.textContent = t(status.sourceMode ? 'status.sourceMode' : 'status.livePreview')
  statusMode.setAttribute('aria-pressed', String(status.sourceMode))
  renderModeStatus()
}

function renderModeStatus(): void {
  // 文字也在这里写：HTML 里留空，免得启动瞬间闪一下写死的中文
  statusFocus.textContent = t('status.focus')
  statusTypewriter.textContent = t('status.typewriter')
  statusFocus.setAttribute('aria-pressed', String(preferences.get('focusMode')))
  statusTypewriter.setAttribute('aria-pressed', String(preferences.get('typewriterMode')))
}

/**
 * 本窗口的稳定标识，用作未命名文档的草稿 key 前缀。
 *
 * 不能用「窗口序号」之类会变的东西：崩溃重启后序号全变了，
 * 旧草稿就成了永远认不出来的孤儿。随机 id 存进 sessionStorage ——
 * 它随窗口活、随窗口死，正是我们要的生命周期。
 */
function windowKey(): string {
  const existing = sessionStorage.getItem('mosu:window-key')
  if (existing) return existing
  const created = crypto.randomUUID()
  sessionStorage.setItem('mosu:window-key', created)
  return created
}

// 显式标注类型：`create` 回调里引用了 `tabs.paths()`，也就是说 tabs 出现在自己的
// 初始化表达式里。不标注的话 TypeScript 只能推成 any，整条链的类型全塌掉
const tabs: TabManager = new TabManager({
  container: editorHost,
  strip: tabStrip,
  windowKey: windowKey(),
  confirm: (options) => host.dialog.confirm(options),
  exists: (path) => host.fs.exists(path),
  onChange: () => {
    render()
    scheduleSessionReport()
  },
  onStatus: (status) => {
    applyStatus(status)
    outline.schedule()
  },
  onDocChange: () => outline.schedule(),
  // 换了一篇文档就把命令面板收掉。它是**瞬时**浮层：过滤文字和候选项都是
  // 冲着刚才那篇文档去的，留在屏幕上只会误导（issue #3）。
  //
  // 设置面板刻意不在此列 —— 那是用户明确打开的模态对话框，
  // 不是「顺手一敲」的东西，切个标签就把它关掉反而莫名其妙。
  onActivate: () => palette.close(),
  create: (parent, context) => {
    // 编辑器要按「自己这个标签的当前路径」解析资源，而路径是控制器持有的，
    // 控制器又要先有编辑器 —— 用一个可变的取值函数把这个环打开
    let pathOf: () => string | null = () => null

    const editor = new MosuEditor({
      parent,
      // 只影响**新建的**标签：已经开着的那些按用户当时的选择留着，
      // 改一个设置就把所有标签的视图切一遍，是很吓人的行为
      sourceMode: preferences.get('sourceModeByDefault'),
      // 专注 / 打字机相反：它们是全局状态，新标签必须**直接带着**开，
      // 否则新开一个标签就掉回普通模式，像是设置没生效
      focusMode: preferences.get('focusMode'),
      typewriterMode: preferences.get('typewriterMode'),
      renderInlineHtml: preferences.get('renderInlineHtml'),
      labels: editorLabels(),
      formatKeys: editorFormatKeys(),
      assetResolver: createAssetResolver(() => {
        const path = pathOf()
        return path ? dirnameOf(path) : null
      }),
      // 架构 01 §6：渲染进程绝不自行导航，链接一律交给系统浏览器；
      // 协议白名单在 main 侧再挡一次
      onOpenLink: (url) => void host.shell.openExternal(url),
      imageSink: async (image) => {
        const path = pathOf()
        // 未保存的新文档没有落脚点，这里**明确报错**而不是找个临时目录糊过去：
        // 图片进了临时目录、Markdown 里却写着相对路径，用户一保存就得到一个
        // 永远加载不出来的引用
        if (!path) throw new Error(t('error.imageNeedsPath'))
        return host.fs.saveAttachment(dirnameOf(path), image)
      },
      onImageError: (error, name) => {
        void host.dialog.message({
          message: t('error.imageInsert', { name }),
          detail: error.message,
        })
      },
      onDocChange: () => {
        controller.notifyEdited()
        context.edited()
      },
      onStatus: (status) => context.status(status),
    })

    const controller = new DocumentController(
      host,
      editor,
      () => context.changed(),
      {
        // 监听的是**全窗口所有标签**的文件集合：单个控制器只知道自己那一份，
        // 而 watcher 那一侧要的是全集（幂等，算错了下次上报自动纠正）
        watch: () => api.fs.watch(tabs.paths()),
        writeDraft: (key, text, meta) => api.drafts.write(key, text, meta),
        dropDraft: (key) => api.drafts.drop(key),
      },
      context.draftKey,
    )
    pathOf = () => controller.state().path

    return { editor, controller }
  },
})

function activeEditor(): MosuEditor {
  return tabs.active().editor
}

function activeController(): DocumentController {
  return tabs.active().controller
}

function currentPath(): string | null {
  return activeController().state().path
}

function render(): void {
  const state = activeController().state()
  statusName.textContent = `${state.dirty ? '● ' : ''}${state.name}`
  statusName.title = state.path ?? t('status.unsaved')

  const bits = [state.meta.encoding.toUpperCase(), state.meta.eol.toUpperCase()]
  if (state.meta.mixedEol) bits.push(t('status.mixedEol'))
  if (state.readOnly) bits.push(t('status.readonly'))
  if (state.deleted) bits.push(t('status.deleted'))
  statusMeta.textContent = bits.join(' · ')

  document.title = `${state.dirty ? '● ' : ''}${state.name} — Mosu`
  files.setActive(state.path)
}

/**
 * 会话上报做了防抖。
 *
 * 切标签、改内容、开关文件树都会触发它，而它每次都要走一趟 IPC。
 * main 那一侧还有一层落盘防抖 —— 两层加起来，连续操作只会写一次盘。
 */
let sessionTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSessionReport(): void {
  if (sessionTimer) clearTimeout(sessionTimer)
  sessionTimer = setTimeout(() => {
    sessionTimer = null
    const snapshot = tabs.snapshot()
    void api.session.report({ folder: files.folder(), ...snapshot })
    void api.fs.watch(tabs.paths())
  }, 300)
}

/** 跑一条编辑命令并把焦点还给编辑器。 */
function runCommand(command: StateCommand): void {
  const editor = activeEditor()
  command({ state: editor.view.state, dispatch: (tr) => editor.view.dispatch(tr) })
  editor.focus()
}

/**
 * 跑一条需要视图的命令（表格那一批）。
 *
 * 跟 `runCommand` 分开是因为 CodeMirror 有两种命令签名：`StateCommand` 只要
 * state 与 dispatch，`Command` 要整个 view。表格命令要读选区并滚动到目标格，
 * 属于后者。
 */
function runViewCommand(command: (view: MosuEditor['view']) => boolean): void {
  const editor = activeEditor()
  command(editor.view)
  editor.focus()
}

/**
 * 「打开」的落点规则（docs/adr/0005 §关键推论 3）。
 *
 * 有了标签页之后这条规则终于是它本来的样子：**在当前窗口新开一个标签**，
 * 除非当前标签正好是一份空白未命名文档（那就地复用）。
 * 「在新窗口打开」是一条独立命令，不抢默认行为。
 */
async function openFileFlow(forceNewWindow: boolean): Promise<void> {
  const picked = await host.dialog.openFile()
  const target = picked?.[0]
  if (!target) return

  if (forceNewWindow) await api.window.create(target)
  else await tabs.openPath(target)
}

async function openFolderFlow(): Promise<void> {
  const picked = await host.dialog.openFile({
    title: t('dialog.openFolder.title'),
    directories: true,
  })
  const dir = picked?.[0]
  if (!dir) return
  await files.openFolder(dir)
}

const themes = new ThemeManager(host.settings)
const preferences = new PreferenceStore(host.settings)
const keys = new KeybindingStore(host.settings)

const files = new FileTreePanel(workspace, {
  list: (dir) => host.fs.list(dir),
  open: (path) => void tabs.openPath(path),
  onFolderChange: () => scheduleSessionReport(),
})

const outline = new OutlinePanel(workspace, {
  items: () => activeEditor().outline(),
  cursor: () => activeEditor().cursor(),
  jumpTo: (pos) => activeEditor().jumpTo(pos),
})

/** 导出与复制共用的上下文。 */
function exportContext(): ExportContext {
  const state = activeController().state()
  const path = state.path
  return {
    markdown: activeEditor().getDoc(),
    title: state.name.replace(/\.md$/i, ''),
    baseDir: path ? dirnameOf(path) : null,
    resolveAsset: (src, baseDir) => buildAssetUrl(baseDir, src),
    // 复用编辑器那份 mermaid 实例：配置是全局的，两份实例会让导出的图
    // 跟屏幕上看到的长得不一样
    renderDiagram: renderMermaid,
  }
}

/** 导出目标的默认文件名 —— 让用户在保存框里自己敲一遍是多余的。 */
function defaultExportPath(extension: string): string {
  const path = currentPath()
  if (path) return path.replace(/\.md$/i, extension)
  return `${activeController().state().name.replace(/\.md$/i, '')}${extension}`
}

async function exportHtmlFlow(): Promise<void> {
  const target = await host.dialog.saveFile({
    title: t('export.html.title'),
    defaultPath: defaultExportPath('.html'),
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  })
  if (!target) return

  try {
    await api.fs.writeText(target, await exportHtmlDocument(exportContext()))
  } catch (error) {
    await host.dialog.message({
      message: t('export.failed'),
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 导出为 PDF。
 *
 * 复用 HTML 导出的全部产物（内联主题、内联 KaTeX 字体、图片转 data URI），
 * 只是把「写文件」换成「交给 Chromium 打印」—— 分页归浏览器管（06 §3）。
 */
async function exportPdfFlow(): Promise<void> {
  const target = await host.dialog.saveFile({
    title: t('export.pdf.title'),
    defaultPath: defaultExportPath('.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (!target) return

  try {
    await api.fs.writePdf(target, await exportPdfHtml(exportContext()), {
      pageSize: preferences.get('pdfPageSize'),
      landscape: preferences.get('pdfLandscape'),
      marginInch: preferences.get('pdfMarginInch'),
    })
  } catch (error) {
    await host.dialog.message({
      message: t('export.failed'),
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

/** 复制为富文本：写 HTML 片段 + 纯文本兜底。 */
async function copyRichTextFlow(): Promise<void> {
  try {
    const html = await exportHtmlFragment(exportContext())
    await api.clipboard.writeHtml(html, activeEditor().getDoc())
  } catch (error) {
    await host.dialog.message({
      message: t('export.copyFailed'),
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

const MENU_ACTIONS: Record<MenuCommand, () => void> = {
  'file.open': () => void openFileFlow(false),
  'file.openInNewWindow': () => void openFileFlow(true),
  'file.newTab': () => {
    tabs.open()
  },
  'file.closeTab': () => void tabs.close(tabs.active().id),
  'file.openFolder': () => void openFolderFlow(),
  'file.closeFolder': () => files.closeFolder(),
  'file.save': () => void activeController().save(),
  'file.saveAs': () => void activeController().saveAs(),
  'file.exportHtml': () => void exportHtmlFlow(),
  'file.exportPdf': () => void exportPdfFlow(),
  'edit.copyRichText': () => void copyRichTextFlow(),
  'view.toggleSource': () => {
    activeEditor().toggleSourceMode()
    activeEditor().focus()
  },
  // 走偏好而不是直接调编辑器：这两个是全局模式，必须同时落到所有标签上
  // 并且持久化。直接调编辑器的话，切个标签就变回去了
  'view.toggleFocus': () => {
    void preferences.set('focusMode', !preferences.get('focusMode'))
    activeEditor().focus()
  },
  'view.toggleTypewriter': () => {
    void preferences.set('typewriterMode', !preferences.get('typewriterMode'))
    activeEditor().focus()
  },
  'view.toggleOutline': () => {
    outline.toggle()
    activeEditor().focus()
  },
  'view.toggleFiles': () => {
    files.toggle()
    activeEditor().focus()
  },
  'view.nextTab': () => tabs.cycle(1),
  'view.prevTab': () => tabs.cycle(-1),
  'view.commandPalette': () => palette.toggle(),
  'view.settings': () => settings.toggle(),
  ...(Object.fromEntries(
    THEMES.map((t) => [`view.theme.${t.id}`, () => void themes.select(t.id)]),
  ) as Record<`view.theme.${(typeof THEMES)[number]['id']}`, () => void>),
  'edit.find': () => {
    openSearchPanel(activeEditor().view)
  },
  'format.bold': () => runCommand(toggleBold),
  'format.italic': () => runCommand(toggleItalic),
  'format.code': () => runCommand(toggleInlineCode),
  'format.heading.0': () => runCommand(setHeading(0)),
  'format.heading.1': () => runCommand(setHeading(1)),
  'format.heading.2': () => runCommand(setHeading(2)),
  'format.heading.3': () => runCommand(setHeading(3)),
  'format.heading.4': () => runCommand(setHeading(4)),
  'format.heading.5': () => runCommand(setHeading(5)),
  'format.heading.6': () => runCommand(setHeading(6)),
  // 默认三行两列：两列是最常见的起手式，三行 = 表头 + 两条正文，
  // 一插进去就能看出这是一张表，而不是一行孤零零的分隔线
  'table.insert': () => runViewCommand(tableInsert(3, 2)),
  'table.rowAbove': () => runViewCommand(tableInsertRowAbove),
  'table.rowBelow': () => runViewCommand(tableInsertRowBelow),
  'table.deleteRow': () => runViewCommand(tableDeleteRow),
  'table.columnBefore': () => runViewCommand(tableInsertColumnBefore),
  'table.columnAfter': () => runViewCommand(tableInsertColumnAfter),
  'table.deleteColumn': () => runViewCommand(tableDeleteColumn),
  'table.align.left': () => runViewCommand(tableAlignColumn('left')),
  'table.align.center': () => runViewCommand(tableAlignColumn('center')),
  'table.align.right': () => runViewCommand(tableAlignColumn('right')),
  'table.align.none': () => runViewCommand(tableAlignColumn('none')),
  'table.format': () => runViewCommand(tableFormat),
}

/**
 * 命令表：菜单与命令面板共用同一份定义（见 commands.ts 的说明）。
 *
 * 从 MENU_ACTIONS 派生而不是另写一遍 —— 两份定义必然会漂移，
 * 而漂移的表现是「菜单里有、面板里搜不到」，用户一眼就能看见。
 */
const COMMAND_IDS = Object.keys(MENU_ACTIONS) as MenuCommand[]

/** 命令表。绑定每次现查 —— 用户在设置里改完，面板里显示的必须当场就对。 */
function allCommands(): Command[] {
  return COMMAND_IDS.map((id) => {
    const binding = keys.get(id)
    return {
      id,
      title: menuCommandTitle(id),
      keywords: id,
      ...(binding ? { binding } : {}),
      run: () => MENU_ACTIONS[id](),
    }
  })
}

const palette = new CommandPalette({
  commands: allCommands,
  restoreFocus: () => activeEditor().focus(),
  mac: () => api.platform.os === 'mac',
})

const settings = new SettingsPanel({
  preferences,
  keys,
  commands: COMMAND_IDS,
  mac: () => api.platform.os === 'mac',
  theme: () => themes.theme,
  selectTheme: (theme) => themes.select(theme),
  language: () => language,
  selectLanguage: (value) => selectLanguage(value),
  restoreFocus: () => activeEditor().focus(),
})

api.on.menuCommand((command) => MENU_ACTIONS[command]?.())

/**
 * 外部要求打开文件（Finder 双击 / 右键「打开方式」/ 命令行参数 / 第二次启动）。
 *
 * 走**和 ⌘O 完全相同的落点规则** —— main 侧不知道当前窗口的标签状况，
 * 只能把文件送过来由渲染进程决定。
 */
api.on.openFile((path) => void tabs.openPath(path))

api.on.fileChanged((notice) => {
  void tabs.notifyExternalChange(notice.path, notice.hash, notice.deleted)
})

api.on.requestClose(() => {
  void tabs.canCloseWindow().then((canClose) => api.respondClose(canClose))
})

statusMode.addEventListener('click', () => {
  activeEditor().toggleSourceMode()
  activeEditor().focus()
})

// 走命令表而不是各写一份：状态栏、菜单、命令面板必须是同一个动作，
// 三处各实现一遍的结果一定是其中一处忘了持久化
statusFocus.addEventListener('click', () => MENU_ACTIONS['view.toggleFocus']?.())
statusTypewriter.addEventListener('click', () => MENU_ACTIONS['view.toggleTypewriter']?.())

/**
 * 崩溃恢复（docs/design/04 §4）。
 *
 * `claim` 在整个应用生命周期里只有第一次调用会返回内容，所以多窗口下
 * 这段代码可以无脑跑，不会弹好几次。
 *
 * 有了标签页之后，多份草稿终于可以在**同一个窗口**里各占一个标签 ——
 * 之前只能一份一个窗口，恢复三份就是三个窗口糊在屏幕上。
 */
async function offerDraftRecovery(): Promise<void> {
  const drafts = await api.drafts.claim()
  if (drafts.length === 0) return

  const names = drafts.map((d) => d.path ?? t('doc.untitledDocument')).join('\n')
  const choice = await host.dialog.confirm({
    message: t('recover.title'),
    detail: t('recover.detail', { names }),
    buttons: [t('recover.restore'), t('recover.discard'), t('recover.later')],
    defaultId: 0,
    cancelId: 2,
  })

  if (choice === 1) {
    await Promise.all(drafts.map((d) => api.drafts.discard(d.id)))
    return
  }
  // 「暂不处理」：草稿留在原地，下次启动还会问。这比默默丢掉安全
  if (choice !== 0) return

  for (const draft of drafts) {
    const tab = tabs.active().controller.isEmptyUntitled() ? tabs.active() : tabs.open()
    await tab.controller.restoreDraft(draft.text, draft.path, draft.baselineHash)
  }
}

/** 恢复上次退出时的形态（docs/adr/0005 §关键推论 5）。 */
async function restoreSession(): Promise<void> {
  const session = await api.session.claim()
  if (!session) return
  if (session.folder && (await host.fs.exists(session.folder))) {
    await files.openFolder(session.folder)
  }
  await tabs.restore(session.tabs, session.active)
}

// 偏好必须在建第一个标签**之前**读完 —— 晚一步的话「默认进源码模式」
// 作用不到启动时那个标签上，用户会觉得这个设置时灵时不灵
// 行内 HTML 的开关跟「默认进源码模式」不同，它**立刻作用到所有标签**：
// 前者是新标签的初始视图（改已开的标签会很吓人），后者是渲染规则，
// 用户在设置里勾掉之后期待的是「我文件里那个 <b> 现在就该露出来」
preferences.onChange((values) => {
  for (const tab of tabs.all()) {
    tab.editor.setRenderInlineHtml(values.renderInlineHtml)
    tab.editor.setFocusMode(values.focusMode)
    tab.editor.setTypewriterMode(values.typewriterMode)
  }
  renderModeStatus()
})

/**
 * 落到 CodeMirror 上的那几条格式键位。
 *
 * 只有格式命令会落下去 —— 其余命令走原生菜单。而**菜单的加速键优先于网页**，
 * 所以这一份平时其实碰不到；它存在是为了「用户把加粗从 ⌘B 挪走之后，
 * ⌘B 不能还在编辑器里偷偷生效」。整份替换，不合并。
 */
function editorFormatKeys(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [command, editorId] of Object.entries(EDITOR_FORMAT_IDS)) {
    const binding = keys.get(command as MenuCommand)
    const key = binding ? toCodeMirrorKey(binding) : null
    if (key) out[editorId] = key
  }
  return out
}

keys.onChange(() => {
  const formatKeys = editorFormatKeys()
  for (const tab of tabs.all()) tab.editor.setFormatKeys(formatKeys)
})

/**
 * 界面语言。
 *
 * 不走 `PreferenceStore`：那份偏好是纯渲染进程的东西，而语言**两个进程都要看**
 * （原生菜单在 main 侧）。所以它直接落在 settings.json 的 `ui.language` 上，
 * main 在 `settingsSet` 里看见这个键就重建菜单 —— 一次写入，两边都对。
 */
let language: LanguageSetting = 'auto'

async function selectLanguage(value: LanguageSetting): Promise<void> {
  if (value === language) return
  language = value
  await host.settings.set(LANGUAGE_KEY, value)
  refreshLanguage()
}

/**
 * 把新语言铺到界面上。
 *
 * `applyLanguage` 返回 false 表示解出来还是同一种语言（比如从 `auto` 显式选到
 * 系统本来就是的那种），此时整轮重绘可以省掉。
 *
 * 这个列表就是「换语言时哪些东西要动」的**唯一清单**。漏一处的表现是界面上
 * 有一小块留在旧语言里 —— 而那种半吊子状态比完全没翻译更让人怀疑。
 */
function refreshLanguage(): void {
  if (!applyLanguage(language, api.platform.locale)) return
  retranslateAll()
}

/**
 * 把当前语言铺到所有「只在构造时写过一次」的地方。
 *
 * **启动时也必须调一次**：面板都在模块顶层构造，那时语言还没从磁盘读回来，
 * 它们身上带的是兜底语言（英文）的文案。漏掉这一步的表现是「系统是中文、
 * 菜单也是中文，唯独面板标题是英文」—— 而且只在启动那一次出现，
 * 用户点一下换语言再换回来就好了，正是最难复现的那种。
 */
function retranslateAll(): void {
  outline.retranslate()
  palette.retranslate()
  files.retranslate()
  settings.retranslate()
  for (const tab of tabs.all()) tab.editor.setLabels(editorLabels())
  tabs.retranslate()
  applyStatus(activeEditor().status())
  render()
}

/** 注入给编辑器内核的那几条文案（内核不认识我们的文案表，见 P3）。 */
function editorLabels(): EditorLabels {
  return {
    editor: t('editor.label'),
    codeLanguage: t('editor.codeLanguage'),
    plainText: t('editor.codeLanguage.plain'),
    taskDone: t('editor.task.done'),
    taskTodo: t('editor.task.todo'),
    imageFailed: (src) => t('editor.image.failed', { src }),
  }
}

void (async () => {
  // 语言要在**别的什么都还没画之前**定下来：晚一步的话第一帧是英文兜底，
  // 用户会看见界面闪一下语言
  const stored = await host.settings.get<unknown>(LANGUAGE_KEY)
  if (isLanguageSetting(stored)) language = stored
  applyLanguage(language, api.platform.locale)

  await Promise.all([themes.init(), preferences.init(), keys.init(COMMAND_IDS)])

  // 读设置是异步的，而「外部要求打开文件」的事件可能在这期间就到了 ——
  // 那时 openPath 已经建过一个标签。无条件再开一个空白标签会把它顶掉，
  // 表现是「从 Finder 双击打开的新窗口里是一篇空文档」
  if (tabs.all().length === 0) tabs.open()
  // 放在建完第一个标签之后：retranslateAll 要重放活动编辑器的状态
  retranslateAll()
  await restoreSession()
  await offerDraftRecovery()
})()
