/**
 * Electron main 进程。
 *
 * 职责边界（架构 01 §3）：窗口、菜单、对话框、文件读写、协议处理。
 * **不做任何 Markdown 解析** —— 那是渲染进程的事。
 */
import path from 'node:path'
import { readdir, stat, writeFile } from 'node:fs/promises'
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
import { renderPdf, type PdfOptions } from './pdf.js'
import { claimSession, flushSession, reportSession, savedSessions } from './session.js'
import type { WindowSession } from './session.js'
import {
  assertAllowed,
  assertAllowedDirectory,
  grantDirectory,
  grantFile,
} from './path-guard.js'
import { allSettings, getSetting, setSetting } from './settings.js'
import { BINDING_KEY_PREFIX, resolveBindings } from '../shared/keys.js'
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

/**
 * 按当前设置重建原生菜单。
 *
 * 每次都从设置里重读而不是缓存一份：菜单重建是几毫秒的事，而缓存意味着多一个
 * 「什么时候失效」的问题 —— 设置文件可以被用户直接改，也可以被另一个窗口改。
 */
async function refreshMenu(): Promise<void> {
  buildMenu(
    { newWindow: () => void createWindow(), focusedWindow },
    resolveBindings(await allSettings()),
  )
}

function registerIpc(): void {
  handle(CHANNELS.fsRead, async (_sender, target: string) => readTextFile(target))
  handle(CHANNELS.fsWrite, async (_sender, target: string, text: string, options) =>
    // 「这是我们自己写的」由 fs-service 在**动手写之前**登记 —— 放在这里
    // （写完之后）会输给文件系统事件的去抖窗口，见 watcher.ts 文件头第 2 条
    writeTextFile(target, text, options as Parameters<typeof writeTextFile>[2]),
  )
  /**
   * 这个路径存在吗。
   *
   * 两件事都要查：**有没有授权**，以及**是不是真的存在**。早先只查了前者 ——
   * 于是「已授权但已被删除的文件」会被报成存在，而工作区目录自身因为不满足
   * 「落在某个已授权目录**里面**」反被报成不存在。会话恢复正好同时踩中这两条。
   */
  handle(CHANNELS.fsExists, async (_sender, target: string) => {
    try {
      const real = await assertAllowed(target).catch(() => assertAllowedDirectory(target))
      await stat(real)
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

  handle(
    CHANNELS.fsWritePdf,
    async (_sender, target: string, html: string, options?: PdfOptions) => {
      const real = await assertAllowed(target)
      await writeFile(real, await renderPdf(html, options))
    },
  )

  handle(CHANNELS.clipboardWriteHtml, async (_sender, html: string, text: string) => {
    // 同时写纯文本兜底：目标应用不支持富文本时才有东西可粘
    clipboard.write({ html, text })
  })

  handle(CHANNELS.fsWatch, async (sender, targets: readonly string[]) => {
    if (sender) await watchFor(sender, targets)
  })

  handle(CHANNELS.draftWrite, async (_sender, key: string, text: string, meta) =>
    writeDraft(key, text, meta as Parameters<typeof writeDraft>[2]),
  )
  handle(CHANNELS.draftDrop, async (_sender, key: string) => dropDraft(key))
  handle(CHANNELS.draftClaim, async () => claimDrafts())
  handle(CHANNELS.draftDiscard, async (_sender, id: string) => dropDraftById(id))

  /**
   * 列目录 —— 文件树用。
   *
   * 路径照常过白名单：不过的话渲染进程可以拿它当一个「任意目录是否存在」的
   * 探针，把整个磁盘摸一遍。用户选过的工作区目录会连同子树一起授权。
   *
   * 不跟随符号链接（`withFileTypes` 给的是链接本身的类型）：跟随的话
   * 一个指回上级的链接就能让文件树无限递归下去。
   */
  handle(CHANNELS.fsList, async (_sender, dir: string) => {
    const real = await assertAllowedDirectory(dir)
    const entries = await readdir(real, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(real, entry.name),
        kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      }))
  })

  handle(
    CHANNELS.dialogOpen,
    async (
      sender,
      options: { title?: string; multiple?: boolean; directories?: boolean } = {},
    ) => {
      if (!sender) return null
      const pickDirectory = options.directories === true
      const result = await dialog.showOpenDialog(sender, {
        title: options.title ?? (pickDirectory ? '打开文件夹' : '打开 Markdown 文件'),
        properties: pickDirectory
          ? ['openDirectory']
          : options.multiple
            ? ['openFile', 'multiSelections']
            : ['openFile'],
        ...(pickDirectory
          ? {}
          : {
              filters: [
                { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
                { name: '全部文件', extensions: ['*'] },
              ],
            }),
      })
      if (result.canceled || result.filePaths.length === 0) return null
      // 用户显式选择 = 授权。这是白名单唯一的入口。
      // 选目录时授权整棵子树 —— 文件树要能列出并打开里面的任何一个文件
      await Promise.all(
        result.filePaths.map((p) => (pickDirectory ? grantDirectory(p) : grantFile(p))),
      )
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
      await grantDirectory(path.dirname(result.filePath))
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
  handle(CHANNELS.settingsSet, async (_sender, key: string, value: unknown) => {
    await setSetting(key, value)
    // 快捷键写进设置之后，菜单上的加速键要跟着变 —— 否则用户改了绑定，
    // 命令面板显示新的、菜单还挂着旧的，而**真正生效的是菜单那份**
    if (key.startsWith(BINDING_KEY_PREFIX)) await refreshMenu()
  })
  handle(CHANNELS.platformInfo, async () => ({
    os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux',
    locale: app.getLocale(),
  }))

  handle(CHANNELS.sessionReport, async (sender, session: WindowSession) => {
    if (sender) await reportSession(sender, session)
  })

  handle(CHANNELS.sessionClaim, async (sender) => (sender ? claimSession(sender) : null))

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

/**
 * 启动时开哪些窗口。
 *
 * 带着文件启动（双击 / 命令行）时**不恢复会话** —— 用户此刻的意图明确就是
 * 「打开这个文件」，先弹出上次那七八个标签只会挡路。会话没有丢，
 * 下次空手启动时还在。
 *
 * 恢复失败（目录被删了、文件被移走了）不该拦住启动：渲染进程那边逐个打开，
 * 打不开的标签自己消失，剩下的照常恢复。
 */
async function openStartupWindows(startupPath: string | null): Promise<void> {
  if (startupPath) {
    await createWindow({ openPath: startupPath })
    return
  }

  const sessions = await savedSessions()
  if (sessions.length === 0) {
    await createWindow()
    return
  }
  for (const session of sessions) {
    // 白名单是**每个进程**的，新进程一片空白。会话里的路径当初都是用户在系统
    // 对话框里亲手选过的，恢复时必须把那份授权一并带回来 —— 不然文件树列不出、
    // 标签一个也打不开，而且失败得悄无声息（`exists` 直接说「不在」）
    if (session.folder) await grantDirectory(session.folder)
    await Promise.all(session.tabs.map(grantFile))
    await createWindow({ session })
  }
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

  /**
   * ⌘Q / 退出菜单：任一窗口的渲染进程说「取消」就会中止整个退出流程。
   *
   * 会话要**等它真的落盘**再退。`before-quit` 不能 await，所以先拦下这一次退出，
   * 写完再重新 quit 一遍 —— 光 `void flushSession()` 的话，进程完全可能在写完
   * 之前就没了（写入本身是原子的，但没写成就是没写成，恢复不了）。
   */
  let sessionFlushed = false
  app.on('before-quit', (event) => {
    beginQuit()
    if (sessionFlushed) return
    event.preventDefault()
    void flushSession().finally(() => {
      sessionFlushed = true
      app.quit()
    })
  })

  void app.whenReady().then(async () => {
    // CSP 注册一次即可：它挂在 defaultSession 上，不是每个窗口一份
    applyContentSecurityPolicy()
    registerAssetHandler()
    registerAppHandler(path.join(dirname, '../renderer'))
    registerIpc()

    const startupPath = pendingOpenPath
    pendingOpenPath = null
    await openStartupWindows(startupPath)

    await refreshMenu()

    app.on('activate', () => {
      if (allWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', handleAllWindowsClosed)
}
