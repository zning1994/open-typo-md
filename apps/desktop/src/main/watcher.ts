/**
 * 文件监听（docs/design/04 §3）。
 *
 * 用 `fs.watch` 而不是 chokidar：我们只盯**单个文件**，不需要递归遍历目录树，
 * 而 chokidar 的价值几乎全在后者。少一个依赖，安装包也少一块。
 * 等 M4.5 的文件树恢复排期、真要监听整个工作区时再换。
 *
 * ## 三个必须处理的现实问题
 *
 * 1. **一次保存会放出好几个事件。** 编辑器（包括我们自己）普遍走
 *    「写临时文件 → rename」，在 inotify 上表现为 rename + change 一串。
 *    所以要去抖，且去抖之后必须**重新读一次内容**再判断，不能信事件本身。
 *
 * 2. **自己保存不该惊动自己。** 写完之后记下新 hash；事件带回来的 hash
 *    跟它一致就直接丢弃。不做这一步的话，每次保存都会弹一次「文件被外部修改」。
 *
 * 3. **原子替换会让 watcher 掉线。** `rename` 之后原来那个 inode 没了，
 *    绑在旧 inode 上的 watch 从此收不到任何事件 —— 表现是「改一次能发现，
 *    第二次就再也发现不了」。所以每次事件之后都重新挂一次 watch。
 */
import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { EVENTS } from '../shared/channels.js'
import { assertAllowed } from './path-guard.js'

/** 文件系统事件的去抖窗口。 */
const DEBOUNCE_MS = 120

export interface FileChangeNotice {
  path: string
  /** 磁盘当前内容的 hash；文件已被删除时为 null。 */
  hash: string | null
  deleted: boolean
}

interface Entry {
  path: string
  watcher: FSWatcher | null
  timer: NodeJS.Timeout | null
  /**
   * 「这个 hash 是我们自己写出去的」。
   *
   * 保存后由 `ignoreNextWrite` 登记，事件对上就丢弃。
   * 只留一个而不是一个集合：保存是串行的，后一次保存的基线本来就该覆盖前一次。
   */
  selfWritten: string | null
}

/** 每个窗口盯一个文件 —— 一窗一文档（标签页在 M4.5，搁置）。 */
const entries = new Map<number, Entry>()

function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function currentState(
  target: string,
): Promise<{ hash: string | null; deleted: boolean }> {
  try {
    const info = await stat(target)
    if (!info.isFile()) return { hash: null, deleted: true }
    return { hash: hashOf(await readFile(target)), deleted: false }
  } catch {
    return { hash: null, deleted: true }
  }
}

function disposeWatcher(entry: Entry): void {
  entry.watcher?.close()
  entry.watcher = null
}

function attach(window: BrowserWindow, entry: Entry): void {
  disposeWatcher(entry)
  try {
    entry.watcher = watch(entry.path, () => schedule(window, entry))
    // 文件被删除、磁盘拔出之类的错误不该让 main 崩掉
    entry.watcher.on('error', () => disposeWatcher(entry))
  } catch {
    // 文件还不存在（刚 rename 走）—— 下一次事件或下一次 watch 时再说
    entry.watcher = null
  }
}

function schedule(window: BrowserWindow, entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    void settle(window, entry)
  }, DEBOUNCE_MS)
}

async function settle(window: BrowserWindow, entry: Entry): Promise<void> {
  // 原子替换换掉了 inode，旧 watch 已经聋了 —— 重新挂
  attach(window, entry)

  const { hash, deleted } = await currentState(entry.path)

  // 自己写出去的，不惊动自己
  if (!deleted && hash !== null && hash === entry.selfWritten) return

  if (window.isDestroyed()) return
  const notice: FileChangeNotice = { path: entry.path, hash, deleted }
  window.webContents.send(EVENTS.fileChanged, notice)
}

/** 开始监听某个窗口打开的文件。传 null 表示不再监听任何文件。 */
export async function watchFor(window: BrowserWindow, target: string | null): Promise<void> {
  const existing = entries.get(window.id)
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer)
    disposeWatcher(existing)
    entries.delete(window.id)
  }
  if (!target) return

  // 监听同样过白名单：renderer 不能靠它去探测任意路径是否存在
  const real = await assertAllowed(target)

  const entry: Entry = { path: real, watcher: null, timer: null, selfWritten: null }
  entries.set(window.id, entry)
  attach(window, entry)
}

/**
 * 登记「刚刚是我们自己写的」。
 *
 * 必须在 rename 完成之后、事件到达之前调用 —— 保存流程是同步等待写入完成的，
 * 而事件至少要等一个去抖窗口，时序上稳妥。
 */
export function ignoreNextWrite(window: BrowserWindow, hash: string): void {
  const entry = entries.get(window.id)
  if (entry) entry.selfWritten = hash
}

export function stopWatching(window: BrowserWindow): void {
  const entry = entries.get(window.id)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  disposeWatcher(entry)
  entries.delete(window.id)
}
