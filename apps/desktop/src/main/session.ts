/**
 * 会话恢复（docs/adr/0005 §关键推论 5）。
 *
 * 恢复的粒度是**窗口 + 它的标签列表**，不是「上次打开的那个文件」。
 * 一个技术文档工作区常年开着七八篇互相引用的文档，只恢复一篇等于没恢复。
 *
 * ## 只存路径，不存内容
 *
 * 会话文件里绝不放文档正文。理由有两条，都不是洁癖：
 *
 * 1. 正文有它自己的持久化通路 —— 磁盘上的文件，以及崩溃草稿（04 §4）。
 *    再存一份就有了第三个真相来源，三者不一致时谁也说不清该信谁。
 * 2. 会话文件会被反复整体重写，把整篇文档塞进去意味着每次切标签都要写一遍。
 *
 * 因此**未命名标签不进会话** —— 它没有可恢复的落点。它的内容由草稿机制负责，
 * 那条路走的是「上次没正常退出」的语义，跟会话恢复是两件事。
 *
 * ## 为什么写在 userData 而不是 `.typo/workspace.json`
 *
 * ADR 里写的是后者。但会话是**跨工作区**的（窗口可以各自开着不同目录，
 * 也可以一个目录都没开），放进某个工作区目录就没地方安置那些没有工作区的窗口。
 * 而且往用户的项目目录里写状态文件，是要被 git 记一笔的 —— 除非用户主动要求，
 * 否则不该发生。
 */
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'

export interface WindowSession {
  /** 文件树打开的目录；没开则为 null。 */
  folder: string | null
  /** 已保存文件的路径，按标签顺序。 */
  tabs: string[]
  /** 活动标签在 `tabs` 里的下标。越界时按 0 处理。 */
  active: number
}

/** 落盘的防抖窗口。切标签会连着触发好几次上报，没必要每次都写。 */
const PERSIST_DEBOUNCE_MS = 400

/** 活着的窗口各自的会话。窗口关掉就从这里移走。 */
const live = new Map<number, WindowSession>()

/** 待恢复的会话，按窗口 id 认领 —— 渲染进程就绪后来取一次就清掉。 */
const pending = new Map<number, WindowSession>()

let persistTimer: ReturnType<typeof setTimeout> | null = null

function sessionFile(): string {
  return path.join(app.getPath('userData'), 'session.json')
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persist()
  }, PERSIST_DEBOUNCE_MS)
}

/**
 * 写盘。**先写临时文件再改名**，跟文档的原子保存是同一个道理（04 §2）。
 *
 * 这不是洁癖：退出时会立刻刷一次盘，而进程随时可能在 `writeFile` 已经把文件
 * 截断、还没写完内容的那一瞬间结束 —— 留下的是一个长度为零或者半截的 JSON。
 * 下次启动解析失败，会话就这么没了，而且是**时有时无**地没，最难查的那一类。
 * rename 是原子的：要么是旧的完整内容，要么是新的完整内容。
 */
async function persist(): Promise<void> {
  const file = sessionFile()
  const temp = `${file}.tmp`
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(temp, JSON.stringify({ windows: [...live.values()] }, null, 2), 'utf8')
    await rename(temp, file)
  } catch {
    // 会话恢复是锦上添花，写不进去不该影响任何别的事
  }
}

function isSession(value: unknown): value is WindowSession {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<WindowSession>
  return (
    (candidate.folder === null || typeof candidate.folder === 'string') &&
    Array.isArray(candidate.tabs) &&
    candidate.tabs.every((t) => typeof t === 'string') &&
    typeof candidate.active === 'number'
  )
}

/**
 * 读出上次退出时的窗口列表。
 *
 * 文件损坏 / 格式不对时**当作没有会话**，不报错也不尝试修复：
 * 恢复失败的代价只是开一个空窗口，而为它弹个错误框纯属打扰。
 */
export async function savedSessions(): Promise<WindowSession[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(sessionFile(), 'utf8'))
    const windows = (raw as { windows?: unknown }).windows
    if (!Array.isArray(windows)) return []
    return windows.filter(isSession).filter((s) => s.folder !== null || s.tabs.length > 0)
  } catch {
    return []
  }
}

/** 窗口创建时挂一份待恢复的会话，等渲染进程来认领。 */
export function stageSession(window: BrowserWindow, session: WindowSession): void {
  pending.set(window.id, session)
}

/** 渲染进程认领自己的会话。只给一次 —— 重新加载页面不该再恢复一遍。 */
export function claimSession(window: BrowserWindow): WindowSession | null {
  const found = pending.get(window.id) ?? null
  pending.delete(window.id)
  return found
}

/**
 * 把路径规范化成真实路径再存。
 *
 * 会话文件是**跨进程**的，两次启动之间没有任何共享上下文，路径的写法就是唯一
 * 的身份。而同一个目录在不同写法下随处可见：Windows 的临时目录常是 8.3 短名
 * （`RUNNER~1`），macOS 的 `/tmp` 是指向 `/private/tmp` 的符号链接。
 * 存下来的是哪一种全看当时是谁给的，下次启动再拿去比对就成了碰运气。
 *
 * 解析不了的（文件已经不在了）原样保留 —— 恢复那一侧本来就要处理「不在了」。
 */
async function canonical(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return target
  }
}

/** 渲染进程上报当前形态。 */
export async function reportSession(
  window: BrowserWindow,
  session: WindowSession,
): Promise<void> {
  const folder = session.folder === null ? null : await canonical(session.folder)
  const tabs = await Promise.all(session.tabs.map(canonical))
  if (window.isDestroyed()) return
  live.set(window.id, { ...session, folder, tabs })
  schedulePersist()
}

export function forgetSession(window: BrowserWindow): void {
  pending.delete(window.id)
  if (live.delete(window.id)) schedulePersist()
}

/** 退出前把当前形态立刻落盘，不等防抖。 */
export async function flushSession(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  await persist()
}
