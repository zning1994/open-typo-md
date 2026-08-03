/**
 * preload：渲染进程与 main 之间唯一的桥。
 *
 * 这个文件是安全边界（架构 01 §3、§6）。它必须小到能一眼看完 ——
 * 每多暴露一个能力，渲染进程被 XSS 之后攻击者就多一件武器。
 *
 * 特别注意：**不暴露 ipcRenderer 本体**。暴露它等于允许调用任意通道，
 * 那么这里所有的收窄都白做了。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, EVENTS, type MenuCommand, type MosuBridgeApi } from '../shared/channels.js'

/** IPC 返回值里若是被包装过的错误，就在渲染进程侧还原成异常抛出。 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args)
  if (typeof result === 'object' && result !== null && '__mosuError' in result) {
    const failure = result as unknown as {
      name: string
      message: string
      data?: Record<string, unknown>
    }
    const error = new Error(failure.message)
    error.name = failure.name
    Object.assign(error, failure.data ?? {})
    throw error
  }
  return result as T
}

function subscribe(channel: string, handler: (...args: never[]) => void): () => void {
  const listener = (_event: unknown, ...args: unknown[]) =>
    (handler as (...a: unknown[]) => void)(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

/**
 * 平台信息必须**同步**拿到。
 *
 * 原来这里是 `invoke().then(…)` 之后往已经暴露出去的对象上写值 —— 那行不通：
 * contextBridge 把值**拷贝**进主世界，事后改 preload 这一侧的原对象，
 * 渲染进程那边一无所知，永远读到默认值 `'linux'`。
 *
 * 后果不只是「macOS 上快捷键提示按 Windows 的样子显示」：快捷键录制会去看
 * `ctrlKey` 而不是 `metaKey`，⌘⇧B 录出来是 `Shift+B`。
 *
 * 所以走 `sendSync`。preload 在页面脚本之前执行，一次同步 IPC 的代价可以忽略，
 * 换来的是「渲染进程任何时刻读到的都是真值」这个简单得多的契约。
 */
const platform = ipcRenderer.sendSync(CHANNELS.platformInfo) as {
  os: 'mac' | 'win' | 'linux'
  locale: string
}

const api: MosuBridgeApi = {
  fs: {
    read: (path) => invoke(CHANNELS.fsRead, path),
    write: (path, text, options) => invoke(CHANNELS.fsWrite, path, text, options),
    list: (dir) => invoke(CHANNELS.fsList, dir),
    exists: (path) => invoke(CHANNELS.fsExists, path),
    saveAttachment: (baseDir, mime, bytes) =>
      invoke(CHANNELS.fsSaveAttachment, baseDir, mime, bytes),
    createFile: (dir, name) => invoke(CHANNELS.fsCreateFile, dir, name),
    createDirectory: (dir, name) => invoke(CHANNELS.fsCreateDirectory, dir, name),
    rename: (target, newName) => invoke(CHANNELS.fsRename, target, newName),
    trash: (target) => invoke(CHANNELS.fsTrash, target),
    titles: (paths) => invoke(CHANNELS.fsTitles, paths),
    walk: (root) => invoke(CHANNELS.fsWalk, root),
    watch: (paths) => invoke(CHANNELS.fsWatch, paths),
    writeText: (path, text) => invoke(CHANNELS.fsWriteText, path, text),
    writePdf: (path, html, options) => invoke(CHANNELS.fsWritePdf, path, html, options),
  },
  clipboard: {
    writeHtml: (html, text) => invoke(CHANNELS.clipboardWriteHtml, html, text),
  },
  search: {
    start: (root, query, options) => invoke(CHANNELS.searchStart, root, query, options),
    cancel: () => invoke(CHANNELS.searchCancel),
  },
  session: {
    report: (session) => invoke(CHANNELS.sessionReport, session),
    claim: () => invoke(CHANNELS.sessionClaim),
  },
  drafts: {
    write: (key, text, meta) => invoke(CHANNELS.draftWrite, key, text, meta),
    drop: (key) => invoke(CHANNELS.draftDrop, key),
    claim: () => invoke(CHANNELS.draftClaim),
    discard: (id) => invoke(CHANNELS.draftDiscard, id),
  },
  dialog: {
    open: (options) => invoke(CHANNELS.dialogOpen, options),
    save: (options) => invoke(CHANNELS.dialogSave, options),
    confirm: (options) => invoke(CHANNELS.dialogConfirm, options),
    message: (options) => invoke(CHANNELS.dialogMessage, options),
  },
  shell: {
    openExternal: (url) => invoke(CHANNELS.shellOpenExternal, url),
  },
  window: {
    create: (path) => invoke(CHANNELS.windowCreate, path),
  },
  menu: {
    context: (request) => invoke(CHANNELS.menuContext, request),
  },
  settings: {
    get: (key) => invoke(CHANNELS.settingsGet, key),
    set: (key, value) => invoke(CHANNELS.settingsSet, key, value),
  },
  platform,
  update: {
    check: () => invoke(CHANNELS.updateCheck),
  },
  on: {
    menuCommand: (handler) =>
      subscribe(EVENTS.menuCommand, handler as (...args: never[]) => void),
    openFile: (handler) => subscribe(EVENTS.openFile, handler as (...args: never[]) => void),
    requestClose: (handler) =>
      subscribe(EVENTS.requestClose, handler as (...args: never[]) => void),
    fileChanged: (handler) =>
      subscribe(EVENTS.fileChanged, handler as (...args: never[]) => void),
    searchProgress: (handler) =>
      subscribe(EVENTS.searchProgress, handler as (...args: never[]) => void),
  },
  respondClose: (canClose) => ipcRenderer.send('respond-close', canClose),
}

contextBridge.exposeInMainWorld('mosu', api)

export type { MenuCommand }
