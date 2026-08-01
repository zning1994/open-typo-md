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
  setHeading,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
} from '@typo/editor'
import type { MenuCommand } from '../shared/channels.js'
import { DocumentController, type DocumentState } from './document.js'
import { createAssetResolver, createHostBridge, dirnameOf, getBridgeApi } from './host.js'
import './styles.css'

const api = getBridgeApi()
const host = createHostBridge()

function require$<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (!found) throw new Error(`页面结构不完整，缺少 ${selector}`)
  return found
}

const editorHost = require$<HTMLElement>('#editor')
const statusName = require$<HTMLElement>('#status-name')
const statusMeta = require$<HTMLElement>('#status-meta')
const statusStats = require$<HTMLElement>('#status-stats')
const statusMode = require$<HTMLButtonElement>('#status-mode')

let currentPath: string | null = null

const editor = new TypoEditor({
  parent: editorHost,
  assetResolver: createAssetResolver(() => (currentPath ? dirnameOf(currentPath) : null)),
  // 架构 01 §6：渲染进程绝不自行导航，链接一律交给系统浏览器；
  // 协议白名单在 main 侧再挡一次
  onOpenLink: (url) => void host.shell.openExternal(url),
  onDocChange: () => controller.notifyEdited(),
  onStatus: (status) => {
    statusStats.textContent = `${status.stats.words} 字 · ${status.stats.line}:${status.stats.column}`
    statusMode.textContent = status.sourceMode ? '源码模式' : '实时预览'
    statusMode.setAttribute('aria-pressed', String(status.sourceMode))
  },
})

const controller = new DocumentController(host, editor, render)

function render(state: DocumentState): void {
  currentPath = state.path
  statusName.textContent = `${state.dirty ? '● ' : ''}${state.name}`
  statusName.title = state.path ?? '尚未保存'

  const bits = [state.meta.encoding.toUpperCase(), state.meta.eol.toUpperCase()]
  if (state.meta.mixedEol) bits.push('混合换行')
  if (state.readOnly) bits.push('只读')
  statusMeta.textContent = bits.join(' · ')

  document.title = `${state.dirty ? '● ' : ''}${state.name} — Brainforge Typo`
}

/** 跑一条编辑命令并把焦点还给编辑器。 */
function runCommand(command: StateCommand): void {
  command({ state: editor.view.state, dispatch: (tr) => editor.view.dispatch(tr) })
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

const MENU_ACTIONS: Record<MenuCommand, () => void> = {
  'file.open': () => void openFileFlow(false),
  'file.openInNewWindow': () => void openFileFlow(true),
  'file.save': () => void controller.save(),
  'file.saveAs': () => void controller.saveAs(),
  'view.toggleSource': () => {
    editor.toggleSourceMode()
    editor.focus()
  },
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
}

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
api.on.requestClose(() => {
  void controller.canClose().then((canClose) => api.respondClose(canClose))
})

statusMode.addEventListener('click', () => {
  editor.toggleSourceMode()
  editor.focus()
})

render(controller.state())
editor.focus()
