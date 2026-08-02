/**
 * 文件监听（docs/design/04 §3）。
 *
 * 用 `fs.watch` 而不是 chokidar：我们只盯**已经打开的那几个文件**，不递归遍历
 * 目录树，而 chokidar 的价值几乎全在后者。少一个依赖，安装包也少一块。
 *
 * 文件树只在展开时读一次目录，**不监听目录** —— 监听整个工作区意味着递归
 * inotify（大仓库上直接爆句柄上限），而它换来的只是「别人在别处新建了文件、
 * 树里自动多一行」。代价和收益完全不成比例，所以树上给了刷新，没给监听。
 *
 * ## 三个必须处理的现实问题
 *
 * 1. **一次保存会放出好几个事件。** 编辑器（包括我们自己）普遍走
 *    「写临时文件 → rename」，在 inotify 上表现为 rename + change 一串。
 *    所以要去抖，且去抖之后必须**重新读一次内容**再判断，不能信事件本身。
 *
 * 2. **自己保存不该惊动自己。** 写之前就把即将落盘的内容 hash 记下来；
 *    事件带回来的 hash 对得上就丢弃。不做这一步的话，每次保存都会报一次
 *    「文件被外部修改」。
 *
 *    **登记必须发生在写入之前**，这是被一次偶发失败逼出来的：文件系统事件在
 *    写的那一刻就产生了，去抖窗口只有 120ms，而「写完 → IPC 返回 → 登记」
 *    这条链路在机器忙的时候完全可能超过 120ms —— 于是自己的保存被报成了外部修改。
 *
 * 3. **原子替换会让 watcher 掉线。** `rename` 之后原来那个 inode 没了，
 *    绑在旧 inode 上的 watch 从此收不到任何事件 —— 表现是「改一次能发现，
 *    第二次就再也发现不了」。所以每次事件之后都重新挂一次 watch。
 *
 * 4. **挂不上的时候必须排重试。** 上面第 3 条只覆盖了「有事件」这条路径。
 *    文件被外部删除时 `attach` 挂不上，早先的做法是把 watcher 置空就完事 ——
 *    那是一条**单向的死路**：没有定时器、没有轮询，文件重新出现也永远收不到
 *    通知。而 `watchFor` 里 `existing.has(real)` 又把这种条目当成「已在监听」
 *    直接跳过，于是**重新调 watchFor 也救不回来**。渲染进程每次上报会话都会
 *    重新武装一遍，一次都不生效。
 *
 *    `git checkout`、从废纸篓恢复、先删后建的同步客户端（OneDrive / Dropbox）
 *    都会走到这条路径 —— 04 §8 早就把它们列为要处理的场景。
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

/**
 * 挂 watch 失败后的重试节奏。
 *
 * 从 500ms 起、每次翻倍、封顶 5s。快的那一头是给 `git checkout`、从废纸篓恢复、
 * 先删后建的同步客户端准备的（文件通常几十毫秒就回来）；封顶是给真的被永久
 * 删掉的文件 —— 那种情况下每秒 stat 一次纯属浪费，而 5s 的延迟没人在意。
 */
const RETRY_MIN_MS = 500
const RETRY_MAX_MS = 5_000

interface Entry {
  /**
   * 渲染进程**请求**时用的那个路径。
   *
   * 跟 `real` 分开是被 macOS 逼出来的：那里 `/var/folders/…` 的真实路径是
   * `/private/var/folders/…`。通知里回传真实路径的话，渲染进程按路径找不到
   * 对应的标签 —— 于是「外部改了文件」这件事在 macOS 上悄无声息地丢掉了。
   * 谁问的就回谁那个写法。
   */
  requested: string
  /** 解析符号链接之后的真实路径，用来挂 watch 与去重。 */
  real: string
  watcher: FSWatcher | null
  timer: NodeJS.Timeout | null
  /**
   * 挂 watch 失败后的重挂定时器，以及当前的退避间隔。
   *
   * 没有这两样的时候，「文件被外部删除」是一条**单向的死路**：`attach` 进了
   * catch 分支把 watcher 置空，从此再没有任何东西会重新挂 —— 文件重新出现也
   * 收不到通知。见文件头第 4 条。
   */
  retry: NodeJS.Timeout | null
  retryDelay: number
}

/**
 * 「这些内容是我们自己写出去的」—— hash → 登记时刻。
 *
 * 不按窗口分组：如果这份内容是本应用写的，那么**任何**窗口都不该把它报成
 * 外部修改（两个窗口开着同一个文件时尤其明显）。
 *
 * 带 TTL 是为了不无限增长。5 秒远大于「写入 → 事件到达」的实际间隔，
 * 又短到不会把几秒后真正的外部修改误当成自己人。
 */
const selfWritten = new Map<string, number>()
const SELF_WRITE_TTL_MS = 5_000

function prune(now: number): void {
  for (const [hash, at] of selfWritten) {
    if (now - at > SELF_WRITE_TTL_MS) selfWritten.delete(hash)
  }
}

/**
 * 窗口 → 它正盯着的文件。
 *
 * 一个窗口可以开好几个标签，每个标签一份自己的文件，所以是一层嵌套的表。
 * 按**真实路径**（`assertAllowed` 解析过的）做键：两个标签通过不同的符号链接
 * 打开同一个文件时，只应该有一个 watcher。
 */
const entries = new Map<number, Map<string, Entry>>()

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

function clearRetry(entry: Entry): void {
  if (entry.retry) clearTimeout(entry.retry)
  entry.retry = null
}

/**
 * 排一次重挂。
 *
 * 挂上之后**要主动 settle 一次**：文件是在我们聋着的这段时间里回来的，
 * 没有任何事件会告诉渲染进程这件事。不补这一下的话，用户看到的是
 * 「文件回来了，但编辑器还以为它被删了」，而下一次保存会拿陈旧的缓冲区
 * 盖掉刚回来的内容。
 */
function scheduleRetry(window: BrowserWindow, entry: Entry): void {
  clearRetry(entry)
  const delay = entry.retryDelay
  entry.retryDelay = Math.min(RETRY_MAX_MS, entry.retryDelay * 2)
  entry.retry = setTimeout(() => {
    entry.retry = null
    if (window.isDestroyed()) return
    attach(window, entry)
    if (entry.watcher) void settle(window, entry)
  }, delay)
}

function attach(window: BrowserWindow, entry: Entry): void {
  disposeWatcher(entry)
  try {
    entry.watcher = watch(entry.real, () => schedule(window, entry))
    // 文件被删除、磁盘拔出之类的错误不该让 main 崩掉。
    // **重挂要排上** —— 否则这条错误路径同样是单向的死路
    entry.watcher.on('error', () => {
      disposeWatcher(entry)
      scheduleRetry(window, entry)
    })
    // 挂上了就把退避重置，下一次掉线仍然反应很快
    entry.retryDelay = RETRY_MIN_MS
    clearRetry(entry)
  } catch {
    // 文件还不存在（刚 rename 走、或者被删了）——
    // 排一次重挂，别把它永远丢在这儿
    entry.watcher = null
    scheduleRetry(window, entry)
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

  const { hash, deleted } = await currentState(entry.real)

  // 自己写出去的，不惊动自己
  const now = Date.now()
  prune(now)
  if (!deleted && hash !== null && selfWritten.has(hash)) return

  if (window.isDestroyed()) return
  const notice: FileChangeNotice = { path: entry.requested, hash, deleted }
  window.webContents.send(EVENTS.fileChanged, notice)
}

function release(entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer)
  clearRetry(entry)
  disposeWatcher(entry)
}

/**
 * 把某个窗口监听的文件集合**整体换成** `targets`。
 *
 * 传全集而不是增量：渲染进程那边标签开开关关，让它维护一份增量指令必然会漏 ——
 * 漏掉的表现是「关掉的标签还在收文件变更通知」或者「新标签的文件根本没人盯」。
 * 全集是幂等的，算错了下一次上报就自动纠正。
 */
export async function watchFor(
  window: BrowserWindow,
  targets: readonly string[],
): Promise<void> {
  // 监听同样过白名单：renderer 不能靠它去探测任意路径是否存在。
  // 先全部解析完再动手，免得中途抛错留下一个改了一半的集合
  // 真实路径 → 请求时的写法
  const wanted = new Map<string, string>()
  const rejected: unknown[] = []
  for (const target of targets) {
    try {
      const real = await assertAllowed(target)
      if (!wanted.has(real)) wanted.set(real, target)
    } catch (error) {
      rejected.push(error)
    }
  }

  const existing = entries.get(window.id) ?? new Map<string, Entry>()
  for (const [real, entry] of existing) {
    const requested = wanted.get(real)
    if (requested === undefined) {
      release(entry)
      existing.delete(real)
      continue
    }
    // 同一个文件换了个写法来请求：通知要跟着改用新写法
    entry.requested = requested
  }
  for (const [real, requested] of wanted) {
    const found = existing.get(real)
    if (found) {
      // **已经在表里 ≠ 还在监听。** 原来这里直接 `continue`，于是一个 watcher
      // 为 null 的条目永远跳过 —— 而渲染进程每次上报会话都会重新调这个函数，
      // 等于「不停地重新武装，但一次都不生效」。
      if (!found.watcher && !found.retry) attach(window, found)
      continue
    }
    const entry: Entry = {
      requested,
      real,
      watcher: null,
      timer: null,
      retry: null,
      retryDelay: RETRY_MIN_MS,
    }
    existing.set(real, entry)
    attach(window, entry)
  }

  if (existing.size === 0) entries.delete(window.id)
  else entries.set(window.id, existing)

  // 有效的那些已经生效了，无效的仍然要说出来 —— 静默忽略等于「监听莫名其妙没了」
  if (rejected[0]) throw rejected[0]
}

/**
 * 登记「接下来落盘的这份内容是我们自己写的」。
 *
 * **必须在写入之前调用。** 见文件头第 2 条：事件在写的那一刻就产生，
 * 写完再登记会输给去抖窗口。
 */
export function noteSelfWrite(hash: string): void {
  prune(Date.now())
  selfWritten.set(hash, Date.now())
}

export function stopWatching(window: BrowserWindow): void {
  const existing = entries.get(window.id)
  if (!existing) return
  for (const entry of existing.values()) release(entry)
  entries.delete(window.id)
}
