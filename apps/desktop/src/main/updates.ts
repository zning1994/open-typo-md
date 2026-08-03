/**
 * 检查更新。
 *
 * ## 三条边界，一条都不能松
 *
 * 这是这个应用**第一个主动发出去的网络请求**，而 Mosu 的立身之本是「本地优先、
 * 不要求账户、不把文档交出去」。所以：
 *
 * 1. **只在用户按下菜单里那一项时才发。** 没有启动时自动检查，没有后台轮询。
 * 2. **一个匿名 GET，不带任何标识。** 没有 token、没有机器 id、没有用户名，
 *    也不上报当前版本 —— 版本比较在本地做，服务端不需要知道你是谁、装的哪版。
 * 3. **设置里能整个关掉。** 关掉之后菜单项灰掉，而且这一层也会拒绝
 *    （见 index.ts 的处理器）—— 有些环境就是不接受任何对外连接。
 *
 * ## 为什么在 main
 *
 * 渲染进程的 CSP 是 `connect-src 'self' mosu-asset:`，它连不出去，也**不该**
 * 连得出去（01 §6）。放宽 CSP 来做一次版本检查，是为一件小事把整堵墙拆一个口。
 *
 * ## 草稿 Release 不会被看见
 *
 * 发布流程建的是**草稿** Release（见 release.yml），而 GitHub 的
 * `/releases/latest` 按定义排除草稿与预发布。也就是说「打完包但还没决定发」
 * 的那段时间里，用户不会被通知到一个还不存在的版本 —— 这正是想要的行为，
 * 不是巧合，改发布流程时别把它弄丢了。
 */
import { net } from 'electron'

/** GitHub 的 latest release 接口。仓库名走旧 slug，GitHub 那边永久重定向。 */
const LATEST_RELEASE = 'https://api.github.com/repos/zning1994/mosu/releases/latest'

/**
 * 超时。
 *
 * 用户按下「检查更新」之后必须**很快**得到一个结果 —— 哪怕结果是「没连上」。
 * 一个转到天荒地老的菜单项比一句「网络不通」糟得多。
 */
const TIMEOUT_MS = 10_000

export interface UpdateCheck {
  /** 当前版本。 */
  current: string
  /** 线上最新的已发布版本；查不到时为 null。 */
  latest: string | null
  /** 有没有更新的版本。 */
  outdated: boolean
  /** 下载页。有更新时才给。 */
  url: string | null
  /**
   * 没查成的原因（网络不通、被限流、仓库还没有 release）。
   *
   * 跟 `latest === null` 分开：**「查不到」和「已经是最新」必须分得开** ——
   * 把失败显示成「已是最新版本」是在骗用户。
   */
  error: string | null
}

/**
 * 比较两个语义化版本。返回正数表示 `a` 更新。
 *
 * 自己写而不是引一个库：规则就这么几条，而这一条**用字符串比较会错得很安静**
 * —— `'0.10.0' < '0.9.0'` 在字典序下成立，于是发了 0.10.0 之后所有 0.9.x 的
 * 用户都会被告知「已是最新」。这正是要单测钉住的地方。
 *
 * 预发布后缀（`-beta.1`）按 semver 规则排在同版本正式版**之前**。
 * 我们的发布流程不发预发布，但用户可能手动装过一个，那时不该把它当成更新的。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (raw: string): { nums: number[]; pre: string } => {
    const cleaned = raw.trim().replace(/^v/i, '')
    const [core = '', pre = ''] = cleaned.split('-', 2)
    const nums = core.split('.').map((part) => {
      const n = Number.parseInt(part, 10)
      return Number.isFinite(n) ? n : 0
    })
    // 补齐到三段，`1.2` 与 `1.2.0` 是同一个版本
    while (nums.length < 3) nums.push(0)
    return { nums, pre }
  }

  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff
  }

  // 主版本号相同：有预发布后缀的排在前面（1.0.0-beta < 1.0.0）
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre < right.pre ? -1 : 1
}

/** 从接口响应里取 tag 与页面地址。字段缺了就当查不到，不猜。 */
export function readRelease(payload: unknown): { tag: string; url: string } | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  const tag = record['tag_name']
  const url = record['html_url']
  if (typeof tag !== 'string' || !tag) return null
  return { tag, url: typeof url === 'string' && url ? url : LATEST_RELEASE }
}

/**
 * 查一次。
 *
 * 用 Electron 的 `net` 而不是 Node 的 `fetch`：前者走 Chromium 的网络栈，
 * 于是系统代理设置、企业根证书这些东西**自动跟着走**。用 Node 的话，
 * 一台配了公司代理的机器上这个功能会莫名其妙地连不上，而用户完全看不出为什么。
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheck> {
  const fail = (error: string): UpdateCheck => ({
    current: currentVersion,
    latest: null,
    outdated: false,
    url: null,
    error,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await net.fetch(LATEST_RELEASE, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })

    // 限流单独说 —— 「403」对用户毫无意义，而「稍后再试」是可操作的
    if (response.status === 403 || response.status === 429) return fail('rateLimited')
    // 还没有任何已发布的 Release（只有草稿）时 GitHub 给 404。
    // 这不是错误，是「暂时没有可更新的版本」
    if (response.status === 404) return fail('noRelease')
    if (!response.ok) return fail('network')

    const release = readRelease(await response.json())
    if (!release) return fail('network')

    const outdated = compareVersions(release.tag, currentVersion) > 0
    return {
      current: currentVersion,
      latest: release.tag.replace(/^v/i, ''),
      outdated,
      url: outdated ? release.url : null,
      error: null,
    }
  } catch {
    // 超时、DNS 失败、离线全归到这里。**不区分**：对用户来说都是「没连上」，
    // 而把 errno 摊给他看只会让他更困惑
    return fail('network')
  } finally {
    clearTimeout(timer)
  }
}
