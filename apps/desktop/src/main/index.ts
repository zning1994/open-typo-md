/**
 * Electron main 进程。
 *
 * 职责边界（架构 01 §3）：窗口、菜单、对话框、文件读写、协议处理。
 * **不做任何 Markdown 解析** —— 那是渲染进程的事。
 */
import path from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, session, shell } from 'electron'
import { ConflictError, UnsupportedEncodingError } from '@typo/plugin-api'
import { CHANNELS, EVENTS, type IpcFailure } from '../shared/channels.js'
import { APP_ORIGIN, registerAppHandler, registerAppSchemePrivileges } from './app-protocol.js'
import { registerAssetHandler, registerAssetScheme } from './asset-protocol.js'
import { readTextFile, writeTextFile } from './fs-service.js'
import { buildMenu } from './menu.js'
import { assertAllowed, grantDirectory, grantFile } from './path-guard.js'
import { getSetting, setSetting } from './settings.js'

const DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
// main 与 preload 被 esbuild 打成 CJS，因此 __dirname 可用（import.meta 反而不可用）
const dirname = __dirname

let mainWindow: BrowserWindow | null = null
/** 关闭确认：渲染进程回复「可以关」之后置位，避免再次拦截。 */
let closeApproved = false
/** 启动参数里带的待打开文件。 */
let pendingOpenPath: string | null = null

registerAssetScheme()
registerAppSchemePrivileges()

function toFailure(error: unknown): IpcFailure {
  if (error instanceof ConflictError) {
    return {
      __typoError: true,
      name: 'ConflictError',
      message: error.message,
      data: { path: error.path, diskHash: error.diskHash },
    }
  }
  if (error instanceof UnsupportedEncodingError) {
    return { __typoError: true, name: 'UnsupportedEncodingError', message: error.message }
  }
  return {
    __typoError: true,
    name: 'Error',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** 统一的 handler 包装：把异常压成可跨 IPC 传递的结构。 */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as A))
    } catch (error) {
      return toFailure(error)
    }
  })
}

function applyContentSecurityPolicy(): void {
  const policy = [
    "default-src 'none'",
    // 开发模式下 Vite 需要 eval 做 HMR；打包版本严格禁止
    DEV_SERVER_URL ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // 注意：不含 http(s) —— 远程图片默认不加载，避免文档变成追踪信标
    'img-src typo-asset: data: blob:',
    "font-src 'self' data:",
    DEV_SERVER_URL ? "connect-src 'self' ws: http://localhost:*" : "connect-src 'self'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })
}

function createWindow(): void {
  applyContentSecurityPolicy()

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 520,
    minHeight: 400,
    title: 'Typo',
    backgroundColor: '#ffffff',
    webPreferences: {
      // 这三项是安全底线（架构 01 §3），任何改动都必须走 ADR
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(dirname, '../preload/index.cjs'),
      spellcheck: true,
    },
  })

  // 外链一律交给系统浏览器，绝不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 渲染进程被诱导导航到外部页面 = 完全失守，直接掐掉
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith(APP_ORIGIN)
    if (!allowed) {
      event.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })

  mainWindow.on('close', (event) => {
    if (closeApproved || !mainWindow) return
    // 有未保存内容时由渲染进程决定能否关闭
    event.preventDefault()
    mainWindow.webContents.send(EVENTS.requestClose)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    // 走 typo-app:// 而不是 loadFile —— 见 app-protocol.ts 里的原因
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`)
  }

  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingOpenPath) {
      void grantFile(pendingOpenPath).then(() => {
        mainWindow?.webContents.send(EVENTS.openFile, pendingOpenPath)
        pendingOpenPath = null
      })
    }
  })
}

function registerIpc(): void {
  handle(CHANNELS.fsRead, async (target: string) => readTextFile(target))
  handle(CHANNELS.fsWrite, async (target: string, text: string, options) =>
    writeTextFile(target, text, options as Parameters<typeof writeTextFile>[2]),
  )
  handle(CHANNELS.fsExists, async (target: string) => {
    try {
      await assertAllowed(target)
      return true
    } catch {
      return false
    }
  })
  handle(CHANNELS.fsList, async () => {
    // 文件树是 M3 的内容，先明确报错而不是返回一个骗人的空数组
    throw new Error('目录浏览尚未实现（M3）')
  })

  handle(CHANNELS.dialogOpen, async (options: { title?: string; multiple?: boolean } = {}) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title ?? '打开 Markdown 文件',
      properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // 用户显式选择 = 授权。这是白名单唯一的入口
    await Promise.all(result.filePaths.map(grantFile))
    return result.filePaths
  })

  handle(CHANNELS.dialogSave, async (options: { defaultPath?: string } = {}) => {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '另存为',
      defaultPath: options.defaultPath ?? '未命名.md',
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    })
    if (result.canceled || !result.filePath) return null
    await grantFile(result.filePath)
    grantDirectory(path.dirname(result.filePath))
    return result.filePath
  })

  handle(
    CHANNELS.dialogConfirm,
    async (options: {
      message: string
      detail?: string
      buttons: string[]
      defaultId?: number
      cancelId?: number
    }) => {
      if (!mainWindow) return options.cancelId ?? 0
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: options.message,
        detail: options.detail,
        buttons: options.buttons,
        defaultId: options.defaultId ?? 0,
        cancelId: options.cancelId ?? options.buttons.length - 1,
        noLink: true,
      })
      return result.response
    },
  )

  handle(CHANNELS.dialogMessage, async (options: { message: string; detail?: string }) => {
    if (!mainWindow) return
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: options.message,
      detail: options.detail,
      buttons: ['好'],
    })
  })

  handle(CHANNELS.shellOpenExternal, async (url: string) => {
    // 只放行 http(s) 与 mailto —— file:// 和自定义协议可以被用来执行本地程序
    if (!/^(https?|mailto):/i.test(url)) throw new Error(`不允许打开该链接：${url}`)
    await shell.openExternal(url)
  })

  handle(CHANNELS.settingsGet, async (key: string) => getSetting(key))
  handle(CHANNELS.settingsSet, async (key: string, value: unknown) => setSetting(key, value))
  handle(CHANNELS.platformInfo, async () => ({
    os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux',
    locale: app.getLocale(),
  }))

  ipcMain.on('respond-close', (_event, canClose: boolean) => {
    if (!canClose) return
    closeApproved = true
    mainWindow?.close()
  })
}

function fileFromArgv(argv: string[]): string | null {
  const candidate = argv
    .slice(1)
    .find((arg) => !arg.startsWith('-') && /\.(md|markdown|txt)$/i.test(arg))
  return candidate ? path.resolve(candidate) : null
}

// 单实例：第二次启动时把文件交给已有窗口，而不是开出两个编辑器抢同一个文件
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const target = fileFromArgv(argv)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      if (target)
        void grantFile(target).then(() => mainWindow?.webContents.send(EVENTS.openFile, target))
    }
  })

  // macOS：Finder 里双击文件
  app.on('open-file', (event, target) => {
    event.preventDefault()
    if (mainWindow) {
      void grantFile(target).then(() => mainWindow?.webContents.send(EVENTS.openFile, target))
    } else {
      pendingOpenPath = target
    }
  })

  pendingOpenPath = fileFromArgv(process.argv)

  void app.whenReady().then(async () => {
    registerAssetHandler()
    registerAppHandler(path.join(dirname, '../renderer'))
    registerIpc()
    if (pendingOpenPath) await grantFile(pendingOpenPath)
    createWindow()
    buildMenu(() => mainWindow)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
