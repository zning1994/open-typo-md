/**
 * 「按 id 丢弃」的那道闸门（设计 10 §8）。
 *
 * ## 它守的是哪个 bug
 *
 * 渲染进程发起一次请求的形状是：`invoke(start)` 拿一个 id（**异步**），
 * 而事件是 main 主动 `send` 过来的。于是有一段窗口 —— 请求已经在跑、id 还没回来。
 * 这段窗口里到的事件不能丢（那是响应的开头），也不能直接交给 UI（还不知道它属
 * 于谁）。
 *
 * 跨文件搜索踩过一次（issue #39 的自查发现）：上一次搜索的结果被追加进了刚清空
 * 的列表。当时是在面板里就地加了 `awaitingId` + `pending` 两个字段。AI 这边更容
 * 易撞上 —— 流式响应的尾巴比搜索长得多 —— 所以这次把它做成一个能单独测的东西，
 * 而不是又在面板里写一遍。
 *
 * ## 三种事件的下场
 *
 * | 什么时候到 | 怎么办 |
 * | --- | --- |
 * | id 还不知道 | 缓冲 |
 * | id 已知且对得上 | 交给 UI |
 * | id 已知但对不上（上一次请求的尾巴） | **丢掉** |
 *
 * 缓冲**不设上限**。窗口是一次 IPC 往返，正常情况下几条事件；如果哪天它真的堆
 * 起来了，那是别的地方出了问题，而一个静默的上限只会把那个问题藏起来。
 */
import { isTerminal, type AgentEvent } from './events.js'

export type GateState = 'idle' | 'awaiting' | 'active'

export class RequestGate {
  #state: GateState = 'idle'
  #requestId: string | null = null
  #pending: AgentEvent[] = []

  get state(): GateState {
    return this.#state
  }

  get requestId(): string | null {
    return this.#requestId
  }

  /** 发起了一次新请求，id 还不知道。旧请求的一切**当场作废**。 */
  open(): void {
    this.#state = 'awaiting'
    this.#requestId = null
    this.#pending = []
  }

  /**
   * `invoke` 回来了，这次请求的 id 是 `requestId`。
   *
   * 返回缓冲里属于它的那些事件（按到达顺序）。缓冲里 id 对不上的会被丢掉 ——
   * 那是上一次请求的尾巴在这次 `open()` 之前挤进来的。
   */
  identify(requestId: string): AgentEvent[] {
    // 已经被 close() 了（用户在 invoke 回来之前就取消了）。此时认下这个 id 等于
    // 让一个已经放弃的请求复活。
    if (this.#state !== 'awaiting') return []

    this.#state = 'active'
    this.#requestId = requestId
    const buffered = this.#pending.filter((event) => event.requestId === requestId)
    this.#pending = []
    if (buffered.some(isTerminal)) this.close()
    return buffered
  }

  /** 收到一个事件。返回该交给 UI 的（0 条或 1 条）。 */
  receive(event: AgentEvent): AgentEvent[] {
    if (this.#state === 'awaiting') {
      this.#pending.push(event)
      return []
    }
    if (this.#state === 'active' && event.requestId === this.#requestId) {
      // 终止事件之后自动关门：否则「转圈圈」的 UI 状态要靠调用方记得关，
      // 而那正是这类代码最容易漏的一处。
      if (isTerminal(event)) this.close()
      return [event]
    }
    return []
  }

  /** 用户取消，或者请求已经结束。此后到的一切都丢掉。 */
  close(): void {
    this.#state = 'idle'
    this.#requestId = null
    this.#pending = []
  }
}
