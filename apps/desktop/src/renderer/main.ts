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
  TypoEditor,
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
} from '@typo/editor'
import type { MenuCommand } from '../shared/channels.js'
import { MENU_COMMAND_INFO, type Command } from './commands.js'
import { DocumentController } from './document.js'
import { FileTreePanel } from './filetree.js'
import { OutlinePanel } from './outline.js'
import { CommandPalette } from './palette.js'
import { PreferenceStore } from './preferences.js'
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

/**
 * 本窗口的稳定标识，用作未命名文档的草稿 key 前缀。
 *
 * 不能用「窗口序号」之类会变的东西：崩溃重启后序号全变了，
 * 旧草稿就成了永远认不出来的孤儿。随机 id 存进 sessionStorage ——
 * 它随窗口活、随窗口死，正是我们要的生命周期。
 */
function windowKey(): string {
  const existing = sessionStorage.getItem('typo:window-key')
  if (existing) return existing
  const created = crypto.randomUUID()
  sessionStorage.setItem('typo:window-key', created)
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
    statusStats.textContent = `${status.stats.words} 字 · ${status.stats.line}:${status.stats.column}`
    statusMode.textContent = status.sourceMode ? '源码模式' : '实时预览'
    statusMode.setAttribute('aria-pressed', String(status.sourceMode))
    outline.schedule()
  },
  onDocChange: () => outline.schedule(),
  create: (parent, context) => {
    // 编辑器要按「自己这个标签的当前路径」解析资源，而路径是控制器持有的，
    // 控制器又要先有编辑器 —— 用一个可变的取值函数把这个环打开
    let pathOf: () => string | null = () => null

    const editor = new TypoEditor({
      parent,
      // 只影响**新建的**标签：已经开着的那些按用户当时的选择留着，
      // 改一个设置就把所有标签的视图切一遍，是很吓人的行为
      sourceMode: preferences.get('sourceModeByDefault'),
      renderInlineHtml: preferences.get('renderInlineHtml'),
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
        if (!path) throw new Error('请先保存文档，图片才知道该放在哪个目录旁边')
        return host.fs.saveAttachment(dirnameOf(path), image)
      },
      onImageError: (error, name) => {
        void host.dialog.message({
          message: `图片「${name}」没能插入`,
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

function activeEditor(): TypoEditor {
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
  statusName.title = state.path ?? '尚未保存'

  const bits = [state.meta.encoding.toUpperCase(), state.meta.eol.toUpperCase()]
  if (state.meta.mixedEol) bits.push('混合换行')
  if (state.readOnly) bits.push('只读')
  if (state.deleted) bits.push('文件已删除')
  statusMeta.textContent = bits.join(' · ')

  document.title = `${state.dirty ? '● ' : ''}${state.name} — Brainforge Typo`
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
function runViewCommand(command: (view: TypoEditor['view']) => boolean): void {
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
  const picked = await host.dialog.openFile({ title: '打开文件夹', directories: true })
  const dir = picked?.[0]
  if (!dir) return
  await files.openFolder(dir)
}

const themes = new ThemeManager(host.settings)
const preferences = new PreferenceStore(host.settings)

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
    title: '导出为 HTML',
    defaultPath: defaultExportPath('.html'),
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  })
  if (!target) return

  try {
    await api.fs.writeText(target, await exportHtmlDocument(exportContext()))
  } catch (error) {
    await host.dialog.message({
      message: '导出失败',
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
    title: '导出为 PDF',
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
      message: '导出失败',
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
      message: '复制失败',
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
const COMMANDS: Command[] = (Object.keys(MENU_ACTIONS) as MenuCommand[]).map((id) => ({
  id,
  title: MENU_COMMAND_INFO[id].title,
  keywords: id,
  ...(MENU_COMMAND_INFO[id].binding ? { binding: MENU_COMMAND_INFO[id].binding } : {}),
  run: () => MENU_ACTIONS[id](),
}))

const palette = new CommandPalette({
  commands: () => COMMANDS,
  restoreFocus: () => activeEditor().focus(),
  mac: api.platform.os === 'mac',
})

const settings = new SettingsPanel({
  preferences,
  theme: () => themes.theme,
  selectTheme: (theme) => themes.select(theme),
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

  const names = drafts.map((d) => d.path ?? '未命名文档').join('\n')
  const choice = await host.dialog.confirm({
    message: '上次未正常退出，有未保存的修改',
    detail: `${names}\n\n恢复之后仍然需要你手动保存。`,
    buttons: ['恢复', '丢弃', '暂不处理'],
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
    await tab.controller.restoreDraft(draft.text, draft.path)
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
  for (const tab of tabs.all()) tab.editor.setRenderInlineHtml(values.renderInlineHtml)
})

void (async () => {
  await Promise.all([themes.init(), preferences.init()])
  // 读设置是异步的，而「外部要求打开文件」的事件可能在这期间就到了 ——
  // 那时 openPath 已经建过一个标签。无条件再开一个空白标签会把它顶掉，
  // 表现是「从 Finder 双击打开的新窗口里是一篇空文档」
  if (tabs.all().length === 0) tabs.open()
  render()
  await restoreSession()
  await offerDraftRecovery()
})()
