/**
 * 渲染进程入口：把编辑器、文档控制器、外壳 UI 接起来。
 *
 * M0/M1 的界面刻意做得很薄 —— 只有编辑区 + 状态栏，没有侧边栏、没有标签页
 * （那些是 M3 的内容，届时随 @typo/ui 一起做成 React 组件）。
 * 现在多写的 UI 到 M3 都要推翻重来，不如先把内核做扎实。
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
  type ImageSink,
} from '@typo/editor'
import type { MenuCommand } from '../shared/channels.js'
import { MENU_COMMAND_INFO, type Command } from './commands.js'
import { DocumentController, type DocumentState } from './document.js'
import { OutlinePanel } from './outline.js'
import { CommandPalette } from './palette.js'
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
const statusName = require$<HTMLElement>('#status-name')
const statusMeta = require$<HTMLElement>('#status-meta')
const statusStats = require$<HTMLElement>('#status-stats')
const statusMode = require$<HTMLButtonElement>('#status-mode')

let currentPath: string | null = null

/**
 * 粘贴 / 拖入的图片存到当前文件旁边的 `assets/`。
 *
 * 未保存的新文档没有落脚点，这里**明确报错**而不是找个临时目录糊过去：
 * 图片进了临时目录、Markdown 里却写着相对路径，用户一保存就得到一个
 * 永远加载不出来的引用。宁可当场说清楚。
 */
async function saveImage(image: Parameters<ImageSink>[0]): Promise<string> {
  if (!currentPath) throw new Error('请先保存文档，图片才知道该放在哪个目录旁边')
  return host.fs.saveAttachment(dirnameOf(currentPath), image)
}

const editor = new TypoEditor({
  parent: editorHost,
  assetResolver: createAssetResolver(() => (currentPath ? dirnameOf(currentPath) : null)),
  // 架构 01 §6：渲染进程绝不自行导航，链接一律交给系统浏览器；
  // 协议白名单在 main 侧再挡一次
  onOpenLink: (url) => void host.shell.openExternal(url),
  imageSink: saveImage,
  onImageError: (error, name) => {
    void host.dialog.message({
      message: `图片「${name}」没能插入`,
      detail: error.message,
    })
  },
  onDocChange: () => controller.notifyEdited(),
  onStatus: (status) => {
    statusStats.textContent = `${status.stats.words} 字 · ${status.stats.line}:${status.stats.column}`
    statusMode.textContent = status.sourceMode ? '源码模式' : '实时预览'
    statusMode.setAttribute('aria-pressed', String(status.sourceMode))
    outline.schedule()
  },
})

/**
 * 本窗口的稳定标识，用作未命名文档的草稿 key。
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

const controller = new DocumentController(
  host,
  editor,
  render,
  {
    watch: (path) => api.fs.watch(path),
    writeDraft: (key, text, meta) => api.drafts.write(key, text, meta),
    dropDraft: (key) => api.drafts.drop(key),
  },
  windowKey(),
)

function render(state: DocumentState): void {
  currentPath = state.path
  statusName.textContent = `${state.dirty ? '● ' : ''}${state.name}`
  statusName.title = state.path ?? '尚未保存'

  const bits = [state.meta.encoding.toUpperCase(), state.meta.eol.toUpperCase()]
  if (state.meta.mixedEol) bits.push('混合换行')
  if (state.readOnly) bits.push('只读')
  if (state.deleted) bits.push('文件已删除')
  statusMeta.textContent = bits.join(' · ')

  document.title = `${state.dirty ? '● ' : ''}${state.name} — Brainforge Typo`
}

/** 跑一条编辑命令并把焦点还给编辑器。 */
function runCommand(command: StateCommand): void {
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
function runViewCommand(command: (view: typeof editor.view) => boolean): void {
  command(editor.view)
  editor.focus()
}

/**
 * 「打开」的落点规则（docs/adr/0005 §关键推论 3）。
 *
 * 当前窗口还是一份空白未命名文档时就地复用 —— 为了一个空窗口再开一个新窗口，
 * 然后让原来那个空着，很蠢。其余情况一律开新窗口，绝不顶掉用户正在写的东西。
 */
async function openFileFlow(forceNewWindow: boolean): Promise<void> {
  const picked = await host.dialog.openFile()
  const target = picked?.[0]
  if (!target) return

  if (!forceNewWindow && controller.isEmptyUntitled()) {
    await controller.openPath(target, { alreadyConfirmed: true })
  } else {
    await api.window.create(target)
  }
}

const themes = new ThemeManager(host.settings)

const outline = new OutlinePanel(workspace, {
  items: () => editor.outline(),
  cursor: () => editor.cursor(),
  jumpTo: (pos) => editor.jumpTo(pos),
})

const palette = new CommandPalette({
  commands: () => COMMANDS,
  restoreFocus: () => editor.focus(),
  mac: api.platform.os === 'mac',
})

/** 导出与复制共用的上下文。 */
function exportContext(): ExportContext {
  const state = controller.state()
  return {
    markdown: editor.getDoc(),
    title: state.name.replace(/\.md$/i, ''),
    baseDir: currentPath ? dirnameOf(currentPath) : null,
    resolveAsset: (src, baseDir) => buildAssetUrl(baseDir, src),
    // 复用编辑器那份 mermaid 实例：配置是全局的，两份实例会让导出的图
    // 跟屏幕上看到的长得不一样
    renderDiagram: renderMermaid,
  }
}

/**
 * 导出为 HTML。
 *
 * 默认文件名跟着文档走 —— 让用户在保存框里自己敲一遍是多余的。
 */
async function exportHtmlFlow(): Promise<void> {
  const state = controller.state()
  const target = await host.dialog.saveFile({
    title: '导出为 HTML',
    defaultPath: currentPath
      ? currentPath.replace(/\.md$/i, '.html')
      : `${state.name.replace(/\.md$/i, '')}.html`,
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
  const state = controller.state()
  const target = await host.dialog.saveFile({
    title: '导出为 PDF',
    defaultPath: currentPath
      ? currentPath.replace(/\.md$/i, '.pdf')
      : `${state.name.replace(/\.md$/i, '')}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (!target) return

  try {
    await api.fs.writePdf(target, await exportPdfHtml(exportContext()))
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
    await api.clipboard.writeHtml(html, editor.getDoc())
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
  'file.save': () => void controller.save(),
  'file.saveAs': () => void controller.saveAs(),
  'file.exportHtml': () => void exportHtmlFlow(),
  'file.exportPdf': () => void exportPdfFlow(),
  'edit.copyRichText': () => void copyRichTextFlow(),
  'view.toggleSource': () => {
    editor.toggleSourceMode()
    editor.focus()
  },
  'view.toggleOutline': () => {
    outline.toggle()
    editor.focus()
  },
  'view.commandPalette': () => palette.toggle(),
  ...(Object.fromEntries(
    THEMES.map((t) => [`view.theme.${t.id}`, () => void themes.select(t.id)]),
  ) as Record<`view.theme.${(typeof THEMES)[number]['id']}`, () => void>),
  'edit.find': () => {
    openSearchPanel(editor.view)
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

api.on.menuCommand((command) => MENU_ACTIONS[command]?.())

/**
 * 外部要求打开文件（Finder 双击 / 右键「打开方式」/ 命令行参数 / 第二次启动）。
 *
 * 这里必须走**和 ⌘O 完全相同的落点规则** —— main 侧不知道当前窗口脏没脏，
 * 只能把文件送过来由渲染进程决定。早先直接 openPath 会顶掉用户正在写的东西，
 * 这正是「在 Finder 里右键打开会覆盖当前窗口」的原因。
 */
api.on.openFile((path) => {
  void (async () => {
    if (controller.isEmptyUntitled()) {
      await controller.openPath(path, { alreadyConfirmed: true })
    } else {
      await api.window.create(path)
    }
  })()
})
api.on.fileChanged((notice) => {
  void controller.handleExternalChange(notice.hash, notice.deleted)
})

api.on.requestClose(() => {
  void controller.canClose().then((canClose) => api.respondClose(canClose))
})

statusMode.addEventListener('click', () => {
  editor.toggleSourceMode()
  editor.focus()
})

/**
 * 崩溃恢复（docs/design/04 §4）。
 *
 * `claim` 在整个应用生命周期里只有第一次调用会返回内容，所以多窗口下
 * 这段代码可以无脑跑，不会弹好几次。
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

  const [first, ...rest] = drafts
  if (first) await controller.restoreDraft(first.text, first.path)
  // 一窗一文档，剩下的各开一个窗口 —— 标签页在 M4.5，搁置
  for (const draft of rest) {
    if (draft.path) await api.window.create(draft.path)
  }
}

render(controller.state())
editor.focus()
void themes.init()
void offerDraftRecovery()
