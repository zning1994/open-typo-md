/**
 * 窗口注册表。
 *
 * M1 的 main 进程里 `mainWindow` 是个模块级单例，多窗口的第一步就是把它拆掉。
 * 模型见 docs/adr/0005-windows-and-tabs.md：**窗口只负责承载与聚焦，
 * 文档状态都在渲染进程那一侧**，所以这里刻意不存任何文档信息 ——
 * 存了就会和渲染进程的状态打架。
 */
import path from 'node:path'
import { BrowserWindow, app, screen, shell } from 'electron'
import { EVENTS } from '../shared/channels.js'
import { APP_ORIGIN } from './app-protocol.js'
import { getSetting, setSetting } from './settings.js'
import { grantFile } from './path-guard.js'
import { forgetSession, stageSession, type WindowSession } from './session.js'
import { stopWatching } from './watcher.js'

const DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

interface StoredBounds {
  width: number
  height: number
  x?: number
  y?: number
}

const DEFAULT_BOUNDS: StoredBounds = { width: 1100, height: 780 }
const MIN_BOUNDS = { width: 520, height: 400 }
/** 新窗口相对上一个窗口的错位量，免得叠成一摞看不出有几个。 */
const CASCADE_OFFSET = 28

/**
 * 已批准关闭的窗口。
 *
 * 关闭流程要绕一圈渲染进程（那边才知道文档脏没脏），批准之后再调 `close()`
 * 时不能又被拦一次，所以需要这个标记。用 WeakSet 而不是窗口 id，
 * 窗口销毁后自动回收。
 */
const closeApproved = new WeakSet<BrowserWindow>()

/** 用户正在退出应用（⌘Q / 关闭最后一个窗口）。任一窗口取消都会中止整个退出。 */
let quitting = false

export function isQuitting(): boolean {
  return quitting
}

export function beginQuit(): void {
  quitting = true
}

export function cancelQuit(): void {
  quitting = false
}

/**
 * 当前窗口。
 *
 * 菜单命令、对话框归属都要用它 —— M1 里这些全指向 `mainWindow` 单例，
 * 多窗口下那是错的。没有聚焦窗口时（例如 macOS 上点了菜单栏但所有窗口都最小化）
 * 退而取第一个。
 */
export function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

export function allWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows()
}

async function nextBounds(): Promise<StoredBounds> {
  const stored = (await getSetting('window.bounds')) as StoredBounds | undefined
  const base = stored ?? DEFAULT_BOUNDS

  const openCount = BrowserWindow.getAllWindows().length
  if (openCount === 0 || base.x === undefined || base.y === undefined) return base

  // 已经有窗口开着：错开一点，并保证不要错到屏幕外面去
  const area = screen.getPrimaryDisplay().workArea
  const x = base.x + CASCADE_OFFSET * openCount
  const y = base.y + CASCADE_OFFSET * openCount
  const fits = x + base.width <= area.x + area.width && y + base.height <= area.y + area.height
  return fits ? { ...base, x, y } : { width: base.width, height: base.height }
}

function rememberBounds(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
  const { width, height, x, y } = window.getBounds()
  void setSetting('window.bounds', { width, height, x, y })
}

export interface CreateWindowOptions {
  /** 窗口就绪后要打开的文件。 */
  openPath?: string
  /** 待恢复的会话（工作区 + 标签列表）。渲染进程就绪后自己来认领。 */
  session?: WindowSession
}

export async function createWindow(options: CreateWindowOptions = {}): Promise<BrowserWindow> {
  const bounds = await nextBounds()

  const window = new BrowserWindow({
    ...bounds,
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    title: 'Brainforge Typo',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      // 这三项是安全底线（架构 01 §3），任何改动都必须走 ADR
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '../preload/index.cjs'),
      spellcheck: true,
    },
  })

  // 等首帧渲染完再显示，避免白屏一闪
  window.once('ready-to-show', () => window.show())

  // —— 每个窗口都要挂的安全处理（架构 01 §6）——

  // 外链一律交给系统浏览器，绝不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 渲染进程被诱导导航到外部页面 = 完全失守，直接掐掉
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith(APP_ORIGIN)
    if (!allowed) {
      event.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })

  window.on('close', (event) => {
    if (closeApproved.has(window)) {
      rememberBounds(window)
      return
    }
    // 有没有未保存内容只有渲染进程知道，先问它
    event.preventDefault()
    window.webContents.send(EVENTS.requestClose)
  })

  window.on('resized', () => rememberBounds(window))
  window.on('moved', () => rememberBounds(window))

  // 窗口没了就把它的文件监听一起撤掉，否则 watcher 会攥着一个已销毁的窗口
  window.on('closed', () => {
    stopWatching(window)
    // 用户关掉的窗口不该出现在下次启动的恢复列表里 —— 但**退出时不算**。
    // 退出会把所有窗口逐个关掉，照着清的话会话正好在要保存的那一刻被清空，
    // 表现是「每次正常退出都恢复不了，反倒是崩溃之后能恢复」
    if (!isQuitting()) forgetSession(window)
  })

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL)
  } else {
    // 走 typo-app:// 而不是 loadFile —— 见 app-protocol.ts 里的原因
    void window.loadURL(`${APP_ORIGIN}/index.html`)
  }

  if (options.session) stageSession(window, options.session)

  if (options.openPath) {
    const target = options.openPath
    window.webContents.once('did-finish-load', () => {
      void grantFile(target).then(() => {
        if (!window.isDestroyed()) window.webContents.send(EVENTS.openFile, target)
      })
    })
  }

  return window
}

/**
 * 渲染进程对「能不能关」的回复。
 *
 * **这里是 M1 的一个实打实的缺陷所在**：原来的 `respond-close` 通道不带任何
 * 窗口标识，直接操作 `mainWindow` 单例 —— 两个窗口同时在问「要不要保存」时，
 * 回复会串台、关错窗口。现在窗口由调用方从 `event.sender` 反查后传进来。
 */
export function resolveClose(window: BrowserWindow, canClose: boolean): void {
  if (!canClose) {
    // 任何一个窗口说「取消」，整个退出流程都得中止
    cancelQuit()
    return
  }
  closeApproved.add(window)
  rememberBounds(window)
  if (!window.isDestroyed()) window.close()
}

/** 所有窗口都关掉之后的收尾。 */
export function handleAllWindowsClosed(): void {
  // macOS 的约定是关掉窗口不退出应用；但如果用户明确按了 ⌘Q 就要退
  if (process.platform !== 'darwin' || quitting) app.quit()
}
