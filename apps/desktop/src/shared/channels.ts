/**
 * IPC 通道定义 —— main 与 renderer 共用同一份。
 *
 * 架构 01 §5 的约定：通道名集中在这里，一律 invoke/handle（请求-响应），
 * 双端共用类型。散落的字符串通道名是这类应用最容易腐烂的地方。
 */
import type { Draft, DraftMeta } from '../main/drafts.js'
import type { PdfOptions } from '../main/pdf.js'
import type { WindowSession } from '../main/session.js'
import type { FileChangeNotice } from '../main/watcher.js'
import type {
  ConfirmOptions,
  DirEntry,
  OpenDialogOptions,
  ReadResult,
  SaveDialogOptions,
  WriteOptions,
  WriteResult,
} from '@mosu/plugin-api'

export const CHANNELS = {
  fsRead: 'fs:read',
  fsWrite: 'fs:write',
  fsList: 'fs:list',
  fsExists: 'fs:exists',
  fsSaveAttachment: 'fs:save-attachment',
  fsWriteText: 'fs:write-text',
  fsWritePdf: 'fs:write-pdf',
  clipboardWriteHtml: 'clipboard:write-html',
  fsWatch: 'fs:watch',
  draftWrite: 'draft:write',
  draftDrop: 'draft:drop',
  draftClaim: 'draft:claim',
  draftDiscard: 'draft:discard',
  dialogOpen: 'dialog:open',
  dialogSave: 'dialog:save',
  dialogConfirm: 'dialog:confirm',
  dialogMessage: 'dialog:message',
  shellOpenExternal: 'shell:openExternal',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  platformInfo: 'platform:info',
  windowCreate: 'window:create',
  menuContext: 'menu:context',
  sessionReport: 'session:report',
  sessionClaim: 'session:claim',
} as const

/** main → renderer 的推送。 */
export const EVENTS = {
  /** 菜单项被点击。renderer 决定具体做什么。 */
  menuCommand: 'event:menu-command',
  /** 用户通过「用 Mosu 打开」等方式要求打开某个文件。 */
  openFile: 'event:open-file',
  /** 窗口即将关闭，renderer 需要回应能否关闭（有未保存内容时要拦下）。 */
  requestClose: 'event:request-close',
  /** 正在编辑的文件在磁盘上变了（外部程序改的，不是我们自己保存的）。 */
  fileChanged: 'event:file-changed',
} as const

export type { Draft, DraftMeta, FileChangeNotice, PdfOptions, WindowSession }

export type MenuCommand =
  | 'file.open'
  | 'file.openInNewWindow'
  | 'file.save'
  | 'file.saveAs'
  | 'file.exportHtml'
  | 'file.exportPdf'
  | 'file.saveAll'
  | 'file.newTab'
  | 'file.closeTab'
  | 'file.openFolder'
  | 'file.closeFolder'
  | 'view.toggleFiles'
  | 'view.nextTab'
  | 'view.prevTab'
  | 'view.toggleSource'
  | 'view.toggleFocus'
  | 'view.toggleTypewriter'
  | 'view.toggleOutline'
  | 'view.commandPalette'
  | 'view.settings'
  | `view.theme.${'auto' | 'light' | 'dark' | 'sepia' | 'high-contrast' | 'github'}`
  | 'edit.find'
  | 'edit.copyRichText'
  | 'format.bold'
  | 'format.italic'
  | 'format.code'
  | `format.heading.${0 | 1 | 2 | 3 | 4 | 5 | 6}`
  | 'table.insert'
  | 'table.rowAbove'
  | 'table.rowBelow'
  | 'table.deleteRow'
  | 'table.columnBefore'
  | 'table.columnAfter'
  | 'table.deleteColumn'
  | `table.align.${'left' | 'center' | 'right' | 'none'}`
  | 'table.format'

/**
 * 上下文菜单（右键菜单）的请求与结果。
 *
 * ## 为什么是 invoke 而不是「main 弹菜单 → 发命令回来」
 *
 * 标签页那个菜单的每一项都要带上「点的是哪个标签」。走 `menuCommand` 的话，
 * 渲染进程得先把「刚才右键的是谁」存下来等回调 —— 一份跨事件存活的状态，
 * 而它和真实的标签集合必然会有不同步的时候（菜单开着时标签被别的路径关掉）。
 *
 * 改成请求-响应：渲染进程问「用户选了哪一项」，上下文自始至终留在它自己手里。
 * 这也正是 §5 那条「一律 invoke/handle」的约定。
 *
 * 剪切 / 复制 / 粘贴 / 全选**不在返回值里** —— 它们用 Electron 的 role，
 * 由 main 直接作用在聚焦的 webContents 上，压根不需要回渲染进程一趟。
 * 同理「复制文件路径」「在文件夹中显示」也由 main 就地做掉：
 * 路径已经在请求里了，绕回去只是多一次往返和一个新的剪贴板权限。
 */
export type ContextMenuRequest =
  | {
      kind: 'editor'
      /** 有没有选中文本 —— 决定剪切 / 复制 / 查找选中是否可点。 */
      hasSelection: boolean
    }
  | {
      kind: 'tab'
      /** 右键的那个标签是否已经落盘（未命名的没有路径可复制、可显示）。 */
      path: string | null
      /** 还有没有别的标签 / 右边还有没有标签 —— 没有就把对应项禁掉。 */
      hasOthers: boolean
      hasRight: boolean
    }

/** 用户选中的那一项。`null` 表示菜单被取消，或者那一项已经由 main 做掉了。 */
export type ContextMenuResult =
  'tab.close' | 'tab.closeOthers' | 'tab.closeRight' | 'editor.findSelection' | null

/**
 * preload 通过 contextBridge 暴露给渲染进程的全部能力。
 *
 * 刻意收窄：这里没有 `ipcRenderer`、没有 `require`、没有任意通道调用。
 * 渲染进程被 XSS 时，攻击面就是这张表 —— 所以这张表必须小到能一眼看完。
 */
export interface MosuBridgeApi {
  fs: {
    read(path: string): Promise<ReadResult>
    write(path: string, text: string, options: WriteOptions): Promise<WriteResult>
    list(dir: string): Promise<DirEntry[]>
    exists(path: string): Promise<boolean>
    /** 存图片，返回相对 baseDir 的 POSIX 路径。 */
    saveAttachment(baseDir: string, mime: string, bytes: Uint8Array): Promise<string>
    /**
     * 把本窗口监听的文件集合整体换成 `paths`。
     *
     * 传全集而不是增量：标签开开关关时维护增量指令必然会漏，
     * 而全集是幂等的（见 main/watcher.ts）。
     */
    watch(paths: readonly string[]): Promise<void>
    /**
     * 写一份**派生产物**（导出的 HTML）。
     *
     * 跟 `write` 分开是有意的：`write` 带保真元数据与冲突检测，那些是给
     * 「用户正在编辑的文档」准备的；导出产物没有基线可比，也不需要保真。
     * 混用会让冲突检测的语义变得含糊。
     */
    writeText(path: string, text: string): Promise<void>
    /**
     * 把一份自包含 HTML 渲染成 PDF 并落盘。
     *
     * 渲染必须发生在 main 侧：`printToPDF` 是 `webContents` 的能力，
     * 而渲染进程碰不到别的 `webContents`（也不该碰得到）。
     */
    writePdf(path: string, html: string, options?: PdfOptions): Promise<void>
  }
  clipboard: {
    /** 同时写 HTML 与纯文本兜底 —— 目标应用不支持富文本时才有东西可粘。 */
    writeHtml(html: string, text: string): Promise<void>
  }
  session: {
    /** 上报本窗口当前的形态（工作区 + 标签列表），供下次启动恢复。 */
    report(session: WindowSession): Promise<void>
    /** 认领本窗口待恢复的会话。只给一次 —— 重新加载页面不该再恢复一遍。 */
    claim(): Promise<WindowSession | null>
  }
  drafts: {
    write(key: string, text: string, meta: DraftMeta): Promise<void>
    drop(key: string): Promise<void>
    /**
     * 认领可恢复的草稿。**整个应用生命周期里只有第一次调用会返回内容**，
     * 之后一律返回空数组。
     *
     * 为什么要这条规则：恢复提示只该出现一次，而多窗口下每个渲染进程启动时
     * 都会问一遍 —— 没有这条约束，开三个窗口就会弹三次「上次未正常退出」。
     * 把「只有一次」做进协议里，比让每个渲染进程自己想办法协调可靠得多。
     */
    claim(): Promise<Draft[]>
    discard(id: string): Promise<void>
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
  window: {
    /** 新开一个窗口；带 path 则在新窗口里打开该文件。 */
    create(path?: string): Promise<void>
  }
  menu: {
    /** 弹一个上下文菜单，等用户选。见 `ContextMenuRequest` 的说明。 */
    context(request: ContextMenuRequest): Promise<ContextMenuResult>
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
    fileChanged(handler: (notice: FileChangeNotice) => void): () => void
  }
  /**
   * 回应 requestClose：true 表示可以关。
   *
   * main 侧靠 `event.sender` 反查是哪个窗口在回应 —— 消息本身不带窗口 id，
   * 否则渲染进程就能冒充别的窗口（见 docs/adr/0005 §关键推论 2）。
   */
  respondClose(canClose: boolean): void
}

/**
 * 序列化后的错误。
 *
 * Electron 的 IPC 会把 Error 压成字符串，ConflictError 这类需要区分处理的
 * 错误就没法被 renderer 认出来。所以 main 侧统一包成这个结构。
 */
export interface IpcFailure {
  __mosuError: true
  name: string
  message: string
  data?: Record<string, unknown>
}

export function isIpcFailure(value: unknown): value is IpcFailure {
  return typeof value === 'object' && value !== null && '__mosuError' in value
}
