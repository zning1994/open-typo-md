/**
 * IPC 通道定义 —— main 与 renderer 共用同一份。
 *
 * 架构 01 §5 的约定：通道名集中在这里，一律 invoke/handle（请求-响应），
 * 双端共用类型。散落的字符串通道名是这类应用最容易腐烂的地方。
 */
import type {
  ConfirmOptions,
  DirEntry,
  OpenDialogOptions,
  ReadResult,
  SaveDialogOptions,
  WriteOptions,
  WriteResult,
} from '@typo/plugin-api'

export const CHANNELS = {
  fsRead: 'fs:read',
  fsWrite: 'fs:write',
  fsList: 'fs:list',
  fsExists: 'fs:exists',
  dialogOpen: 'dialog:open',
  dialogSave: 'dialog:save',
  dialogConfirm: 'dialog:confirm',
  dialogMessage: 'dialog:message',
  shellOpenExternal: 'shell:openExternal',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  platformInfo: 'platform:info',
} as const

/** main → renderer 的推送。 */
export const EVENTS = {
  /** 菜单项被点击。renderer 决定具体做什么。 */
  menuCommand: 'event:menu-command',
  /** 用户通过「用 Typo 打开」等方式要求打开某个文件。 */
  openFile: 'event:open-file',
  /** 窗口即将关闭，renderer 需要回应能否关闭（有未保存内容时要拦下）。 */
  requestClose: 'event:request-close',
} as const

export type MenuCommand =
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'view.toggleSource'
  | 'edit.find'
  | 'format.bold'
  | 'format.italic'
  | 'format.code'
  | `format.heading.${0 | 1 | 2 | 3 | 4 | 5 | 6}`

/**
 * preload 通过 contextBridge 暴露给渲染进程的全部能力。
 *
 * 刻意收窄：这里没有 `ipcRenderer`、没有 `require`、没有任意通道调用。
 * 渲染进程被 XSS 时，攻击面就是这张表 —— 所以这张表必须小到能一眼看完。
 */
export interface TypoBridgeApi {
  fs: {
    read(path: string): Promise<ReadResult>
    write(path: string, text: string, options: WriteOptions): Promise<WriteResult>
    list(dir: string): Promise<DirEntry[]>
    exists(path: string): Promise<boolean>
  }
  dialog: {
    open(options?: OpenDialogOptions): Promise<string[] | null>
    save(options?: SaveDialogOptions): Promise<string | null>
    confirm(options: ConfirmOptions): Promise<number>
    message(options: { message: string; detail?: string }): Promise<void>
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  settings: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
  platform: {
    os: 'mac' | 'win' | 'linux'
    locale: string
  }
  on: {
    menuCommand(handler: (command: MenuCommand) => void): () => void
    openFile(handler: (path: string) => void): () => void
    requestClose(handler: () => void): () => void
  }
  /** 回应 requestClose：true 表示可以关。 */
  respondClose(canClose: boolean): void
}

/**
 * 序列化后的错误。
 *
 * Electron 的 IPC 会把 Error 压成字符串，ConflictError 这类需要区分处理的
 * 错误就没法被 renderer 认出来。所以 main 侧统一包成这个结构。
 */
export interface IpcFailure {
  __typoError: true
  name: string
  message: string
  data?: Record<string, unknown>
}

export function isIpcFailure(value: unknown): value is IpcFailure {
  return typeof value === 'object' && value !== null && '__typoError' in value
}
