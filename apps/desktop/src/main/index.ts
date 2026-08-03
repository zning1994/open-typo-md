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
import { ConflictError, UnsupportedEncodingError } from '@mosu/plugin-api'
import {
  CHANNELS,
  EVENTS,
  type ContextMenuRequest,
  type IpcFailure,
} from '../shared/channels.js'
import { APP_SCHEME_PRIVILEGES, registerAppHandler } from './app-protocol.js'
import { ASSET_SCHEME_PRIVILEGES, registerAssetHandler } from './asset-protocol.js'
import { claimDrafts, dropDraft, dropDraftById, writeDraft } from './drafts.js'
import { readTextFile, readTitle, saveAttachment, writeTextFile } from './fs-service.js'
import { createDirectory, createFile, renameEntry, trashEntry } from './fs-mutate.js'
import { searchWorkspace, walkWorkspace, type SearchOptions } from './workspace-scan.js'
import { watchFor } from './watcher.js'
import { buildMenu, popupContextMenu } from './menu.js'
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
import { LANGUAGE_KEY } from '../shared/i18n.js'
import { translator } from './i18n.js'
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

/**
 * 每个窗口当前那次搜索的 id。递增即作废上一次（见 `CHANNELS.searchStart`）。
 */
const searchIds = new Map<number, number>()

/** 启动参数里带的待打开文件。 */
let pendingOpenPath: string | null = null

// 所有自定义协议的特权**必须一次性注册**：Electron 只认最后一次调用，
// 各模块各调各的会互相覆盖 —— 而被覆盖掉的那个协议表现得像「部分能用」
// （<img> 加载正常，fetch 一律失败），极难看出问题出在这里
protocol.registerSchemesAsPrivileged([ASSET_SCHEME_PRIVILEGES, APP_SCHEME_PRIVILEGES])

function toFailure(error: unknown): IpcFailure {
  if (error instanceof ConflictError) {
    return {
      __mosuError: true,
      name: 'ConflictError',
      message: error.message,
      data: { path: error.path, diskHash: error.diskHash },
    }
  }
  if (error instanceof UnsupportedEncodingError) {
    return { __mosuError: true, name: 'UnsupportedEncodingError', message: error.message }
  }
  return {
    __mosuError: true,
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
    'img-src mosu-asset: data: blob:',
    "font-src 'self' data:",
    // `mosu-asset:` 必须在 connect-src 里，不只在 img-src 里：
    // 导出「自包含单文件」时要 **fetch** 图片再转 data URI，而 fetch 归
    // connect-src 管。少了它，导出的产物里图片仍是相对路径 —— 而且是**静默**的，
    // 因为 fetch 失败被当成「拿不到就保留原路径」的正常降级。
    // 不扩大权限：这个协议的路径白名单在 main 侧照常生效。
    DEV_SERVER_URL
      ? "connect-src 'self' mosu-asset: ws: http://localhost:*"
      : "connect-src 'self' mosu-asset:",
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
    await translator(),
  )
}

function registerIpc(): void {
  handle(CHANNELS.fsRead, async (_sender, target: string) =>
    readTextFile(target, await translator()),
  )
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
      saveAttachment(baseDir, mime, bytes, await translator()),
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

  /**
   * 工作区里的改动（issue #36）。四条都走 `assertWritableInWorkspace` ——
   * 三条许可里最窄的那条。**不要图省事换成 `assertAllowed`**：后者接受任何
   * 落在「用户打开过的文件所在目录」里的路径，而那份授权的本意只是让相对
   * 路径的图片能加载。读一张图和删一个文件不是一个量级的事。
   */
  handle(CHANNELS.fsCreateFile, async (_sender, dir: string, name: string) =>
    createFile(dir, name, await translator()),
  )
  handle(CHANNELS.fsCreateDirectory, async (_sender, dir: string, name: string) =>
    createDirectory(dir, name, await translator()),
  )
  handle(CHANNELS.fsRename, async (_sender, target: string, newName: string) =>
    renameEntry(target, newName, await translator()),
  )
  handle(CHANNELS.fsTrash, async (_sender, target: string) =>
    trashEntry(target, await translator()),
  )

  /**
   * 批量取文档标题 —— 文件树拿第一个标题当主标签。
   *
   * **一条读不出来不能拖垮整批**：目录里混着二进制文件、没权限的文件、
   * 刚被别人删掉的文件都很正常，而用户只是展开了一个目录。所以逐条兜住，
   * 读不出来就记 null，由渲染进程回退到文件名。
   */
  handle(CHANNELS.fsTitles, async (_sender, targets: readonly string[]) => {
    const out: Record<string, string | null> = {}
    await Promise.all(
      targets.map(async (target) => {
        out[target] = await readTitle(target).catch(() => null)
      }),
    )
    return out
  })

  handle(CHANNELS.fsWalk, async (_sender, root: string) => walkWorkspace(root))

  /**
   * 全工作区搜索（issue #39）。
   *
   * 结果**推**回去而不是一次返回：几百份文档搜完要几百毫秒到几秒，而这段时间
   * 里界面必须已经在出结果了。
   *
   * 「同时只有一次搜索」是在 main 这边保证的，不是靠渲染进程自觉：
   * 每次 start 都把该窗口的 id 递增，跑着的那次每批检查一下自己是不是还是
   * 当前那个 —— 不是就当场收手。让调用方自己去取消是一条必然会漏的路径
   * （面板关掉、窗口关掉、用户连敲五个字符，每一条都要记得取消）。
   *
   * id 按窗口存：两个窗口各搜各的，互不作废。
   */
  handle(
    CHANNELS.searchStart,
    async (sender, root: string, query: string, options: SearchOptions) => {
      if (!sender) return 0
      const id = (searchIds.get(sender.id) ?? 0) + 1
      searchIds.set(sender.id, id)

      // 不 await：这个 invoke 要立刻返回 id，搜索在后台跑
      void searchWorkspace(
        root,
        query,
        options,
        (progress) => {
          // 窗口可能在搜索跑到一半时被关掉
          if (sender.isDestroyed()) return
          sender.webContents.send(EVENTS.searchProgress, { id, ...progress })
        },
        () => sender.isDestroyed() || searchIds.get(sender.id) !== id,
      ).catch(() => {
        // 遍历失败（工作区被删、权限没了）不该让渲染进程永远停在「搜索中」
        if (!sender.isDestroyed()) {
          sender.webContents.send(EVENTS.searchProgress, {
            id,
            matches: [],
            done: true,
            truncated: false,
          })
        }
      })
      return id
    },
  )

  handle(CHANNELS.searchCancel, async (sender) => {
    if (sender) searchIds.set(sender.id, (searchIds.get(sender.id) ?? 0) + 1)
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
    return Promise.all(
      entries
        .filter((entry) => entry.isFile() || entry.isDirectory())
        .map(async (entry) => {
          const full = path.join(real, entry.name)
          // 修改时间是「按修改时间排序」要的，`readdir` 给不出，只能逐个 stat。
          // 一条失败不能拖垮整个目录 —— 条目可能在两次系统调用之间被删掉，
          // 而那不该让文件树整层消失
          const mtimeMs = await stat(full)
            .then((info) => info.mtimeMs)
            .catch(() => undefined)
          return {
            name: entry.name,
            path: full,
            kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
            ...(mtimeMs === undefined ? {} : { mtimeMs }),
          }
        }),
    )
  })

  handle(
    CHANNELS.dialogOpen,
    async (
      sender,
      options: { title?: string; multiple?: boolean; directories?: boolean } = {},
    ) => {
      if (!sender) return null
      const t = await translator()
      const pickDirectory = options.directories === true
      const result = await dialog.showOpenDialog(sender, {
        title:
          options.title ??
          (pickDirectory ? t('dialog.openFolder.title') : t('dialog.open.title')),
        properties: pickDirectory
          ? ['openDirectory']
          : options.multiple
            ? ['openFile', 'multiSelections']
            : ['openFile'],
        ...(pickDirectory
          ? {}
          : {
              filters: [
                {
                  name: t('dialog.filter.markdown'),
                  extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'],
                },
                { name: t('dialog.filter.all'), extensions: ['*'] },
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
      const t = await translator()
      const result = await dialog.showSaveDialog(sender, {
        title: options.title ?? t('dialog.saveAs.title'),
        defaultPath: options.defaultPath ?? t('doc.untitled'),
        filters: options.filters ?? [
          { name: t('dialog.filter.markdown'), extensions: ['md', 'markdown'] },
        ],
      })
      if (result.canceled || !result.filePath) return null
      // 只授权这个文件，**不授权它所在的目录**。
      //
      // 原来这里还跟着一句 `grantDirectory(dirname(filePath))`，而
      // `grantDirectory` 会把目录写进 `workspaceRoots`，`assertAllowedDirectory`
      // 在其上是递归的 —— 于是「另存为到 ~/Documents」顺带把整个 ~/Documents
      // 的**目录枚举**权交了出去。`dialog:open` 从来没这么做过，两者行为不一致。
      //
      // path-guard.ts §权限拆分 专门写了这两种权限不能合并，`path-guard.test.ts`
      // 里还有一条测试叫「只打开过一个文件时，它所在的目录不能列」——
      // 这一行破坏的正是那条不变量守着的东西。
      //
      // 实测去掉之后另存为的全部相关操作照常成功：fs:write、fs:save-attachment、
      // 导出用的 fs:write-text 都只需要文件级授权。
      await grantFile(result.filePath)
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
        buttons: [(await translator())('dialog.ok')],
      })
    },
  )

  handle(CHANNELS.shellOpenExternal, async (_sender, url: string) => {
    // 只放行 http(s) 与 mailto —— file:// 和自定义协议可以被用来执行本地程序
    if (!/^(https?|mailto):/i.test(url)) {
      throw new Error((await translator())('error.linkBlocked', { url }))
    }
    await shell.openExternal(url)
  })

  handle(CHANNELS.settingsGet, async (_sender, key: string) => getSetting(key))
  handle(CHANNELS.settingsSet, async (_sender, key: string, value: unknown) => {
    await setSetting(key, value)
    // 快捷键写进设置之后，菜单上的加速键要跟着变 —— 否则用户改了绑定，
    // 命令面板显示新的、菜单还挂着旧的，而**真正生效的是菜单那份**
    // 语言变了菜单也要重建 —— 否则用户在设置里换了语言，面板立刻变了、
    // 菜单还挂着旧语言，看着像只翻译了一半
    if (key.startsWith(BINDING_KEY_PREFIX) || key === LANGUAGE_KEY) await refreshMenu()
  })
  // 平台信息走**同步** IPC：preload 要在暴露 API 之前就把它填进去。
  // 走 invoke 的话渲染进程会先读到一个默认值，而 contextBridge 是按值拷贝的，
  // 事后再改 preload 那一侧的对象根本传不过去（这个坑真踩过，见 preload/index.ts）
  ipcMain.on(CHANNELS.platformInfo, (event) => {
    event.returnValue = {
      os:
        process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux',
      locale: app.getLocale(),
    }
  })

  handle(CHANNELS.sessionReport, async (sender, session: WindowSession) => {
    if (sender) await reportSession(sender, session)
  })

  handle(CHANNELS.sessionClaim, async (sender) => (sender ? claimSession(sender) : null))

  /**
   * 在新窗口打开一个文件。
   *
   * **绝不在这里 `grantFile(target)`。** 那一行曾经在，是一个把整个路径白名单
   * 架空的洞：`grantFile` 是**授权**原语不是校验原语，它无条件把文件加进白名单、
   * 并把它**所在目录**加进 `allowedDirs`，而 `assertAllowed` 在目录上是递归放行的。
   * 于是渲染进程只要调一次 `window.create('~/.ssh/id_rsa')`，就把 `~/.ssh` 整棵
   * 子树交了出去 —— 读和写都放开，而且**目标文件根本不需要存在**
   * （`realpath` 失败被 catch 掉，dirname 照样入表）。
   *
   * 删掉它不影响任何现有行为：唯一的调用方（renderer 的 openFileFlow）只在
   * `dialog.openFile()` 返回之后才走到这儿，而 `dialog:open` 已经授权过那个路径，
   * 授权又是进程全局的。
   *
   * 光删这一行还不够 —— `createWindow` 里也有一份同样的 `grantFile(openPath)`，
   * 走的是同一条通道，删了这边不删那边等于没修。那一份也一并删了，
   * 改成由**每个调用点**在确认路径来自用户之后自己授权。
   *
   * 校验交给下游：真正要读写时 `assertAllowed` 会拦，没授权就拒。
   * 这一层的职责只是开窗口。
   */
  /**
   * 右键菜单（issues #17 / #18）。
   *
   * 用**发起请求的那个窗口**弹，不是 `getFocusedWindow()`：多窗口下后者在
   * 菜单弹出的这一瞬间未必还是同一个（用户可以在右键之后切窗口），
   * 而 `event.sender` 说的是「谁问的」，那才是菜单该属于的窗口。
   */
  handle(CHANNELS.menuContext, async (sender, request: ContextMenuRequest) => {
    // `handle` 已经把 event.sender 反查成了 BrowserWindow
    if (!sender) return null
    return popupContextMenu(sender, request, await translator())
  })

  handle(CHANNELS.windowCreate, async (_sender, target?: string) => {
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
    // 这条路径来自命令行参数或 macOS 的 `open-file` 事件 —— 是用户在
    // 访达/终端里亲手指定的，等价于在对话框里选中它，所以在这里授权。
    // （`createWindow` 自己不再授权，理由见 window-manager.ts 里 openPath 那段。）
    await grantFile(startupPath)
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
