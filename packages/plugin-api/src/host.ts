/**
 * HostBridge —— 编辑器内核与宿主环境之间的唯一接缝。
 *
 * 设计约束（见 docs/design/01-architecture.md §4）：
 * - 内核（@typo/editor、@typo/markdown）不得直接 import 任何 Node / Electron API。
 * - 所有宿主能力都通过注入的 HostBridge 获得。
 * - 因此内核可以在纯 Node 测试环境里跑（用 createMemoryHost），也可以将来跑在
 *   浏览器（File System Access API）或别的桌面壳里。
 *
 * 所有方法一律返回 Promise —— 即便当前实现是同步的。原因见
 * docs/adr/0004-plugin-isolation.md：为将来把插件/宿主逻辑挪进独立进程留路，
 * 避免届时推倒重来。
 */

/** 文件的字符编码。M0 只支持这几种；遇到其他编码会被 read 拒绝。 */
export type Encoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be'

/** 换行符风格。 */
export type Eol = 'lf' | 'crlf'

/**
 * 打开文件时记录下来的「保真元数据」。保存时按它原样还原，
 * 从而做到「打开 → 不编辑 → 保存」后字节完全一致（目标 G2）。
 */
export interface TextFileMeta {
  encoding: Encoding
  eol: Eol
  /**
   * 原文件是否含混合换行符。
   *
   * 已知限制：缓冲区内统一用 \n，保存时统一按 `eol` 还原，因此混合换行的文件
   * 保存后会被统一。UI 必须在打开时提示用户。详见 docs/design/04 §2。
   */
  mixedEol: boolean
}

export interface ReadResult {
  text: string
  meta: TextFileMeta
  /** 磁盘 mtime，用于冲突检测（见 docs/design/04 §3）。 */
  mtimeMs: number
  /** 内容的 sha256，mtime 精度不可靠时作为兜底比对。 */
  hash: string
  /** 文件是否只读（无写权限）。 */
  readOnly: boolean
}

export interface WriteResult {
  mtimeMs: number
  hash: string
}

export interface WriteOptions {
  meta: TextFileMeta
  /**
   * 期望的磁盘基线 hash。若磁盘上的内容与之不符，说明文件被外部改过，
   * 写入会以 `ConflictError` 失败而不是静默覆盖。传 null 表示新文件。
   */
  expectedHash: string | null
}

export interface DirEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
}

export interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  multiple?: boolean
}

export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  /**
   * 文件类型过滤器。不传时按 Markdown。
   *
   * 导出需要它：不然「导出为 HTML」弹出来的对话框只让存 `.md`，
   * 用户得自己把扩展名改回去。
   */
  filters?: readonly { name: string; extensions: readonly string[] }[]
}

export interface ConfirmOptions {
  message: string
  detail?: string
  buttons: string[]
  /** 默认按钮下标。 */
  defaultId?: number
  /** 按 Esc 时选中的按钮下标。 */
  cancelId?: number
}

/**
 * 一份待落盘的附件。
 *
 * `mime` 是权威的类型来源 —— 宿主据它决定扩展名，**不采信 `name`**
 * （见 docs/design/04 §5：字节和文件名都来自渲染进程，不可信）。
 * `name` 只用来给插入的 Markdown 生成 alt 文本。
 */
export interface AttachmentInput {
  mime: string
  bytes: Uint8Array
  /** 来源文件名，可能为空。 */
  name?: string
}

export interface HostFs {
  read(path: string): Promise<ReadResult>
  write(path: string, text: string, options: WriteOptions): Promise<WriteResult>
  list(dir: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  /**
   * 把工作区内的资源路径解析成渲染层可加载的 URL。
   *
   * Electron 实现返回 `typo-asset://…`（受路径白名单约束，见 01 §6），
   * 绝不返回 `file://`。
   */
  resolveAssetUrl(path: string, baseDir: string): Promise<string>
  /**
   * 把附件存进 `baseDir` 下的附件目录，返回**相对 baseDir 的 POSIX 路径**
   * （例如 `assets/ab12….png`），可以直接写进 Markdown。
   *
   * 不支持的类型、超限的体积一律抛错，绝不静默丢弃 —— 用户以为图片进去了
   * 而实际没有，是最难排查的一类问题。
   */
  saveAttachment(baseDir: string, attachment: AttachmentInput): Promise<string>
}

export interface HostDialog {
  openFile(options?: OpenDialogOptions): Promise<string[] | null>
  saveFile(options?: SaveDialogOptions): Promise<string | null>
  confirm(options: ConfirmOptions): Promise<number>
  message(options: { message: string; detail?: string }): Promise<void>
}

export interface HostShell {
  openExternal(url: string): Promise<void>
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
}

export interface HostPlatform {
  os: 'mac' | 'win' | 'linux'
  locale: string
}

export interface HostBridge {
  fs: HostFs
  dialog: HostDialog
  shell: HostShell
  settings: KeyValueStore
  platform: HostPlatform
}

/** 写入时发现磁盘内容与基线不符。调用方必须走冲突处理流程，不得重试覆盖。 */
export class ConflictError extends Error {
  override readonly name = 'ConflictError'
  constructor(
    readonly path: string,
    readonly diskHash: string,
  ) {
    super(`文件已被外部修改：${path}`)
  }
}

/** 读取到无法按支持的编码解码的内容（例如二进制文件伪装成 .md）。 */
export class UnsupportedEncodingError extends Error {
  override readonly name = 'UnsupportedEncodingError'
  constructor(readonly path: string) {
    super(`无法作为文本文件打开：${path}`)
  }
}
