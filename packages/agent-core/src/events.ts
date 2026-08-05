/**
 * Agent 的事件流与失败分类（设计 10 §7、§8）。
 *
 * 每个事件都带 `requestId`。**这不是冗余** —— 上一次请求的事件完全可能在新请求
 * 已经开始之后才到，没有 id 就没法丢弃它们。跨文件搜索踩过一次（issue #39），
 * 流式响应的尾巴比搜索长得多，这里只会更容易撞上。丢弃逻辑在 `stream.ts`。
 */
import type { Patch } from './patch.js'

/**
 * 失败**必须分类**，不能合并成一句「AI 暂时不可用」。
 *
 * 这是检查更新那条教训的同一个形态（09 §2.5）：把「连不上」显示成「已经是最新
 * 版本」是在骗用户。这里合并五种失败的后果是，用户唯一能做的就是重试，
 * 而其中四种重试一万次也没用。
 */
export type AgentFailure =
  /** 没配 provider 或没配 key */
  | { kind: 'no-credentials' }
  /** 在设置里关掉了。拦截发生在 main，请求根本没发出去 */
  | { kind: 'disabled' }
  /** 连不上：断网、DNS、代理 */
  | { kind: 'offline' }
  /** 被限流。`retryAfterMs` 有就显示「几分钟后再试」，没有就只说被限流了 */
  | { kind: 'rate-limited'; retryAfterMs?: number }
  /** Provider 明确回了错（认证失败、模型不存在、上下文超长……） */
  | { kind: 'provider-error'; status?: number; message: string }
  /** Runtime 自己出的问题。这一类要能跟上面几种区分开，否则永远查不出是谁的锅 */
  | { kind: 'runtime-error'; message: string }

export type AgentEvent =
  | { type: 'started'; requestId: string }
  /** 增量文本。`delta` 是新增的那一段，不是全文 —— 全文由订阅方自己累加 */
  | { type: 'text'; requestId: string; delta: string }
  | { type: 'tool-call'; requestId: string; callId: string; name: string; input: unknown }
  | { type: 'tool-result'; requestId: string; callId: string; ok: boolean }
  /** 模型提出了一处改动。**它还没有被应用**，要经过映射与用户确认（apply.ts） */
  | { type: 'patch'; requestId: string; patch: Patch }
  | { type: 'done'; requestId: string; reason: 'complete' | 'cancelled' }
  | { type: 'failed'; requestId: string; failure: AgentFailure }

/**
 * 这一条之后不会再有同 id 的事件了。
 *
 * 单独写成函数而不是让每处自己判断 `type === 'done' || type === 'failed'`：
 * 将来加一种终止事件时，漏改的那一处会表现成「转圈圈停不下来」。
 */
export function isTerminal(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'failed'
}
