/**
 * `AgentRuntime`：换掉 Pi 时唯一要重写的那个接口（ADR-0006 不变量 2 / 4）。
 *
 * **这个文件里只有类型。** 它的全部价值在于：业务层看见的是这里的东西，
 * 不是 Pi 的类型。哪天换成别的 Runtime，改的是
 * `apps/desktop/src/main/agent/pi-adapter.ts` 一个文件。
 *
 * 这份接口是在**没有读过 Pi 实际 API** 的情况下写的（ADR-0006 末尾的诚实义务）。
 * M5 的 spike 要回答三个问题，其中「Pi 自带的文件 / shell 工具能不能关掉」如果
 * 答案是「不能」，那 Pi 就不是这个位置上的正确选择 —— 而那正是把它藏在这个接口
 * 后面的目的。
 */
import type { AgentEvent } from './events.js'
import type { ToolDescriptor } from './tools.js'

/**
 * 默认上下文：**只有当前文档**（10 §4.1）。
 *
 * 工作区的内容按需读取，模型自己调 `searchWorkspace`。不预扫的理由里最硬的一条
 * 是：**不预扫等于「用户没让它看的文件，它就没看过」** —— 这句话是 Local-first
 * 的产品能对用户说的话里最值钱的一句。
 */
export interface AgentContext {
  document: {
    /** 未命名文档是 null */
    path: string | null
    text: string
    /** 与 Patch 的 `baseVersion` 是同一个东西（apply.ts） */
    version: number
  }
  selection?: { from: number; to: number; text: string }
  cursor?: number
  /**
   * 标题树。刻意只留 `level` + `text` 两个字段，**不 import `@mosu/markdown`
   * 的大纲类型** —— 为两个字段拉一条依赖，换来的是这个包不再是叶子。
   */
  outline?: ReadonlyArray<{ level: number; text: string }>
  /** YAML front matter 的原文，没有就不给 */
  frontMatter?: string
}

export interface AgentRequest {
  prompt: string
  context: AgentContext
  /** 这次允许模型用哪些工具。**不是「全部工具」的同义词** —— 由调用方决定 */
  tools: ToolDescriptor[]
}

export interface AgentRunHandle {
  /**
   * 请求 id。**同步可得** —— Runtime 跑在 main，那里没有「id 还没回来」的窗口。
   * 那个窗口在渲染进程一侧，由 `RequestGate` 处理（stream.ts）。
   */
  readonly requestId: string
  /** 请求**真的停下来**之后 resolve。永不 reject —— 失败走 `failed` 事件 */
  readonly done: Promise<void>
  cancel(): void
}

export interface AgentRuntime {
  run(request: AgentRequest, onEvent: (event: AgentEvent) => void): AgentRunHandle
}

/**
 * 为什么不用 `AbortSignal`
 *
 * 两个理由，第二个才是主要的：
 *
 * 1. 这个包的 `lib` 只有 ES2022，没有 DOM —— `AbortSignal` 在这里根本没有类型；
 * 2. **「已请求取消」和「已经真的停了」是两个状态。** 只给一个 signal 的话，
 *    调用方拿不到后者，UI 上停止按钮按下去像是没反应（10 §8）。
 *    `cancel()` + `done` 把两者分开了。
 */
