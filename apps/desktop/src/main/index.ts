/**
 * Electron main 进程。
 *
 * 职责边界（架构 01 §3）：窗口、菜单、对话框、文件读写、协议处理。
 * **不做任何 Markdown 解析** —— 那是渲染进程的事。
 */
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
} from 'electron'
import { ConflictError, UnsupportedEncodingError } from '@typo/plugin-api'
import { CHANNELS, EVENTS, type IpcFailure } from '../shared/channels.js'
import { APP_SCHEME_PRIVILEGES, registerAppHandler } from './app-protocol.js'
import { ASSET_SCHEME_PRIVILEGES, registerAssetHandler } from './asset-protocol.js'
import { claimDrafts, dropDraft, dropDraftById, writeDraft } from './drafts.js'
import { readTextFile, saveAttachment, writeTextFile } from './fs-service.js'
import { watchFor } from './watcher.js'
import { buildMenu } from './menu.js'
import { assertAllowed, grantDirectory, grantFile } from './path-guard.js'
import { getSetting, setSetting } from './settings.js'
import {
  allWindows,
  beginQuit,
  createWindow,
  focusedWindow,
  handleAllWindowsClosed,
  resolveClose,
} from './window-manager.js'

const DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
// main 与 preload 被 esbuild 打成 CJS，因此 __dirname 可用（import.meta 反而不可用）
const dirname = __dirname

/** 启动参数里带的待打开文件。 */
let pendingOpenPath: string | null = null

// 所有自定义协议的特权**必须一次性注册**：Electron 只认最后一次调用，
// 各模块各调各的会互相覆盖 —— 而被覆盖掉的那个协议表现得像「部分能用」
// （<img> 加载正常，fetch 一律失败），极难看出问题出在这里
protocol.registerSchemesAsPrivileged([ASSET_SCHEME_PRIVILEGES, APP_SCHEME_PRIVILEGES])

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

/**
 * 统一的 handler 包装：把异常压成可跨 IPC 传递的结构，
 * 并把**发送方窗口**交给 handler。
 *
 * 后者是多窗口的硬性要求：对话框必须挂在发问的那个窗口上，
 * 挂错窗口在 macOS 上会变成另一个窗口的工作表，用户根本找不到。
 */
function handle<A extends unknown[], R>(
  channel: string,
  fn: (sender: BrowserWindow | null, ...args: A) => Promise<R>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(BrowserWindow.fromWebContents(event.sender), ...(args as A))
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
    // `typo-asset:` 必须在 connect-src 里，不只在 img-src 里：
    // 导出「自包含单文件」时要 **fetch** 图片再转 data URI，而 fetch 归
    // connect-src 管。少了它，导出的产物里图片仍是相对路径 —— 而且是**静默**的，
    // 因为 fetch 失败被当成「拿不到就保留原路径」的正常降级。
    // 不扩大权限：这个协议的路径白名单在 main 侧照常生效。
    DEV_SERVER_URL
      ? "connect-src 'self' typo-asset: ws: http://localhost:*"
      : "connect-src 'self' typo-asset:",
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

function registerIpc(): void {
  handle(CHANNELS.fsRead, async (_sender, target: string) => readTextFile(target))
  handle(CHANNELS.fsWrite, async (_sender, target: string, text: string, options) =>
    // 「这是我们自己写的」由 fs-service 在**动手写之前**登记 —— 放在这里
    // （写完之后）会输给文件系统事件的去抖窗口，见 watcher.ts 文件头第 2 条
    writeTextFile(target, text, options as Parameters<typeof writeTextFile>[2]),
  )
  handle(CHANNELS.fsExists, async (_sender, target: string) => {
    try {
      await assertAllowed(target)
      return true
    } catch {
      return false
    }
  })
  handle(
    CHANNELS.fsSaveAttachment,
    async (_sender, baseDir: string, mime: string, bytes: Uint8Array) =>
      saveAttachment(baseDir, mime, bytes),
  )
  /**
   * 写导出产物。
   *
   * 跟 fsWrite 分开：那条带保真元数据与冲突检测，是给「用户正在编辑的文档」
   * 准备的；导出产物没有基线可比。路径仍然过白名单 —— 导出目标由用户在
   * 保存对话框里选，选完即授权。
   */
  handle(CHANNELS.fsWriteText, async (_sender, target: string, text: string) => {
    const real = await assertAllowed(target)
    await writeFile(real, text, 'utf8')
  })

  handle(CHANNELS.clipboardWriteHtml, async (_sender, html: string, text: string) => {
    // 同时写纯文本兜底：目标应用不支持富文本时才有东西可粘
    clipboard.write({ html, text })
  })

  handle(CHANNELS.fsWatch, async (sender, target: string | null) => {
    if (sender) await watchFor(sender, target)
  })

  handle(CHANNELS.draftWrite, async (_sender, key: string, text: string, meta) =>
    writeDraft(key, text, meta as Parameters<typeof writeDraft>[2]),
  )
  handle(CHANNELS.draftDrop, async (_sender, key: string) => dropDraft(key))
  handle(CHANNELS.draftClaim, async () => claimDrafts())
  handle(CHANNELS.draftDiscard, async (_sender, id: string) => dropDraftById(id))

  handle(CHANNELS.fsList, async () => {
    // 文件树是 M3 的内容，先明确报错而不是返回一个骗人的空数组
    throw new Error('目录浏览尚未实现（M3）')
  })

  handle(
    CHANNELS.dialogOpen,
    async (sender, options: { title?: string; multiple?: boolean } = {}) => {
      if (!sender) return null
      const result = await dialog.showOpenDialog(sender, {
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
    },
  )

  handle(
    CHANNELS.dialogSave,
    async (
      sender,
      options: {
        title?: string
        defaultPath?: string
        filters?: { name: string; extensions: string[] }[]
      } = {},
    ) => {
      if (!sender) return null
      const result = await dialog.showSaveDialog(sender, {
        title: options.title ?? '另存为',
        defaultPath: options.defaultPath ?? '未命名.md',
        filters: options.filters ?? [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      })
      if (result.canceled || !result.filePath) return null
      await grantFile(result.filePath)
      grantDirectory(path.dirname(result.filePath))
      return result.filePath
    },
  )

  handle(
    CHANNELS.dialogConfirm,
    async (
      sender,
      options: {
        message: string
        detail?: string
        buttons: string[]
        defaultId?: number
        cancelId?: number
      },
    ) => {
      if (!sender) return options.cancelId ?? 0
      const result = await dialog.showMessageBox(sender, {
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

  handle(
    CHANNELS.dialogMessage,
    async (sender, options: { message: string; detail?: string }) => {
      if (!sender) return
      await dialog.showMessageBox(sender, {
        type: 'info',
        message: options.message,
        detail: options.detail,
        buttons: ['好'],
      })
    },
  )

  handle(CHANNELS.shellOpenExternal, async (_sender, url: string) => {
    // 只放行 http(s) 与 mailto —— file:// 和自定义协议可以被用来执行本地程序
    if (!/^(https?|mailto):/i.test(url)) throw new Error(`不允许打开该链接：${url}`)
    await shell.openExternal(url)
  })

  handle(CHANNELS.settingsGet, async (_sender, key: string) => getSetting(key))
  handle(CHANNELS.settingsSet, async (_sender, key: string, value: unknown) =>
    setSetting(key, value),
  )
  handle(CHANNELS.platformInfo, async () => ({
    os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux',
    locale: app.getLocale(),
  }))

  handle(CHANNELS.windowCreate, async (_sender, target?: string) => {
    if (target) await grantFile(target)
    await createWindow(target ? { openPath: target } : {})
  })

  // 关闭回应必须能反查是哪个窗口 —— 见 window-manager.ts 的 resolveClose
  ipcMain.on('respond-close', (event, canClose: boolean) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) resolveClose(window, canClose)
  })
}

/** 把文件送到当前窗口；没有窗口就新开一个。 */
async function openInFocusedWindow(target: string): Promise<void> {
  await grantFile(target)
  const window = focusedWindow()
  if (!window) {
    await createWindow({ openPath: target })
    return
  }
  if (window.isMinimized()) window.restore()
  window.focus()
  window.webContents.send(EVENTS.openFile, target)
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
    if (target) void openInFocusedWindow(target)
    else void createWindow()
  })

  // macOS：Finder 里双击文件
  app.on('open-file', (event, target) => {
    event.preventDefault()
    if (allWindows().length > 0) void openInFocusedWindow(target)
    else pendingOpenPath = target
  })

  pendingOpenPath = fileFromArgv(process.argv)

  // ⌘Q / 退出菜单：任一窗口的渲染进程说「取消」就会中止整个退出流程
  app.on('before-quit', () => beginQuit())

  void app.whenReady().then(async () => {
    // CSP 注册一次即可：它挂在 defaultSession 上，不是每个窗口一份
    applyContentSecurityPolicy()
    registerAssetHandler()
    registerAppHandler(path.join(dirname, '../renderer'))
    registerIpc()

    const startupPath = pendingOpenPath
    pendingOpenPath = null
    await createWindow(startupPath ? { openPath: startupPath } : {})

    buildMenu({
      newWindow: () => void createWindow(),
      focusedWindow,
    })

    app.on('activate', () => {
      if (allWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', handleAllWindowsClosed)
}
