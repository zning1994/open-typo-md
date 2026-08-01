/**
 * 内存版 HostBridge —— 供单元测试与 Storybook 式演示使用。
 *
 * 存在的意义（见 docs/design/01-architecture.md §4）：编辑器的绝大部分逻辑
 * 应该能在不启动 Electron 的情况下测试。任何需要真实文件系统才能测的东西，
 * 说明抽象漏了。
 */
import {
  ConflictError,
  type DirEntry,
  type HostBridge,
  type ReadResult,
  type TextFileMeta,
  type WriteOptions,
  type WriteResult,
} from '../host.js'

export const DEFAULT_META: TextFileMeta = { encoding: 'utf8', eol: 'lf', mixedEol: false }

/** 非加密的内容指纹，仅用于「内容有没有变」的判定。测试环境够用。 */
export function weakHash(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13)
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
  return hex(h1) + hex(h2) + hex(text.length)
}

interface MemFile {
  text: string
  meta: TextFileMeta
  mtimeMs: number
  readOnly: boolean
}

export interface MemoryHost extends HostBridge {
  /** 直接塞一个文件进去，模拟磁盘上已有的内容。 */
  seed(path: string, text: string, meta?: Partial<TextFileMeta>): void
  /** 模拟外部程序（另一个编辑器、git checkout）改了文件。 */
  externalEdit(path: string, text: string): void
  /** 读出当前「磁盘」内容，用于断言。 */
  peek(path: string): string | undefined
  /** 记录已弹出的对话框，用于断言「该问的问了、不该问的没问」。 */
  readonly dialogLog: string[]
  /** 预置 confirm 的返回值队列。 */
  answerConfirmWith(...indices: number[]): void
}

export function createMemoryHost(options: { os?: 'mac' | 'win' | 'linux' } = {}): MemoryHost {
  const files = new Map<string, MemFile>()
  const settings = new Map<string, unknown>()
  const dialogLog: string[] = []
  const confirmAnswers: number[] = []
  let clock = 1_000

  const touch = () => (clock += 1_000)

  const host: MemoryHost = {
    fs: {
      async read(path: string): Promise<ReadResult> {
        const f = files.get(path)
        if (!f) throw new Error(`ENOENT: ${path}`)
        return {
          text: f.text,
          meta: f.meta,
          mtimeMs: f.mtimeMs,
          hash: weakHash(f.text),
          readOnly: f.readOnly,
        }
      },
      async write(path: string, text: string, options: WriteOptions): Promise<WriteResult> {
        const existing = files.get(path)
        if (existing && options.expectedHash !== null) {
          const diskHash = weakHash(existing.text)
          if (diskHash !== options.expectedHash) throw new ConflictError(path, diskHash)
        }
        const mtimeMs = touch()
        files.set(path, {
          text,
          meta: options.meta,
          mtimeMs,
          readOnly: existing?.readOnly ?? false,
        })
        return { mtimeMs, hash: weakHash(text) }
      },
      async list(dir: string): Promise<DirEntry[]> {
        const prefix = dir.endsWith('/') ? dir : `${dir}/`
        const seen = new Map<string, DirEntry>()
        for (const path of files.keys()) {
          if (!path.startsWith(prefix)) continue
          const rest = path.slice(prefix.length)
          const slash = rest.indexOf('/')
          const name = slash === -1 ? rest : rest.slice(0, slash)
          seen.set(name, {
            name,
            path: prefix + name,
            kind: slash === -1 ? 'file' : 'directory',
          })
        }
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
      },
      async exists(path: string) {
        return files.has(path)
      },
      async resolveAssetUrl(path: string) {
        return `memory-asset:${path}`
      },
    },
    dialog: {
      async openFile() {
        dialogLog.push('openFile')
        return null
      },
      async saveFile() {
        dialogLog.push('saveFile')
        return null
      },
      async confirm(opts) {
        dialogLog.push(`confirm:${opts.message}`)
        return confirmAnswers.shift() ?? opts.defaultId ?? 0
      },
      async message(opts) {
        dialogLog.push(`message:${opts.message}`)
      },
    },
    shell: {
      async openExternal(url: string) {
        dialogLog.push(`openExternal:${url}`)
      },
    },
    settings: {
      async get<T>(key: string) {
        return settings.get(key) as T | undefined
      },
      async set<T>(key: string, value: T) {
        settings.set(key, value)
      },
    },
    platform: { os: options.os ?? 'linux', locale: 'zh-CN' },

    seed(path, text, meta) {
      files.set(path, {
        text,
        meta: { ...DEFAULT_META, ...meta },
        mtimeMs: touch(),
        readOnly: false,
      })
    },
    externalEdit(path, text) {
      const f = files.get(path)
      files.set(path, {
        text,
        meta: f?.meta ?? DEFAULT_META,
        mtimeMs: touch(),
        readOnly: f?.readOnly ?? false,
      })
    },
    peek(path) {
      return files.get(path)?.text
    },
    dialogLog,
    answerConfirmWith(...indices) {
      confirmAnswers.push(...indices)
    },
  }
  return host
}
