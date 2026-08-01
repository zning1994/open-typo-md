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
import { CHANNELS, EVENTS, type MenuCommand, type TypoBridgeApi } from '../shared/channels.js'

/** IPC 返回值里若是被包装过的错误，就在渲染进程侧还原成异常抛出。 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args)
  if (typeof result === 'object' && result !== null && '__typoError' in result) {
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

const api: TypoBridgeApi = {
  fs: {
    read: (path) => invoke(CHANNELS.fsRead, path),
    write: (path, text, options) => invoke(CHANNELS.fsWrite, path, text, options),
    list: (dir) => invoke(CHANNELS.fsList, dir),
    exists: (path) => invoke(CHANNELS.fsExists, path),
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
  settings: {
    get: (key) => invoke(CHANNELS.settingsGet, key),
    set: (key, value) => invoke(CHANNELS.settingsSet, key, value),
  },
  platform: {
    // 同步值，启动时由 main 注入（见下方 bootstrap）
    os: 'linux',
    locale: 'zh-CN',
  },
  on: {
    menuCommand: (handler) =>
      subscribe(EVENTS.menuCommand, handler as (...args: never[]) => void),
    openFile: (handler) => subscribe(EVENTS.openFile, handler as (...args: never[]) => void),
    requestClose: (handler) =>
      subscribe(EVENTS.requestClose, handler as (...args: never[]) => void),
  },
  respondClose: (canClose) => ipcRenderer.send('respond-close', canClose),
}

// 平台信息在暴露之前先取到，让渲染进程可以同步读取（用于快捷键提示等）
void invoke<{ os: 'mac' | 'win' | 'linux'; locale: string }>(CHANNELS.platformInfo)
  .then((info) => {
    api.platform.os = info.os
    api.platform.locale = info.locale
  })
  .catch(() => undefined)

contextBridge.exposeInMainWorld('typo', api)

export type { MenuCommand }
