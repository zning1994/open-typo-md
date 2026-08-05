/**
 * `@mosu/agent-core` —— AI 那一层的**协议**，不是它的实现。
 *
 * 这个包**零运行时依赖**，不 import Node、不 import Electron、不 import Pi、
 * 也不 import 编辑器。设计见 `docs/design/10-ai.md`，决策见 ADR-0006。
 *
 * 它为什么必须是这样：一个 import 了 Pi 的包，说自己跟 Pi 解耦是没有意义的。
 * 切成这样之后，「换掉 Runtime」在机械上等于「换掉 `pi-adapter.ts`」，
 * `pnpm layers` 能替我们盯着。
 */
export {
  validatePatch,
  patchDelta,
  type Patch,
  type PatchEdit,
  type PatchProblem,
} from './patch.js'

export {
  mapPatch,
  changedRangesFrom,
  type ChangedRange,
  type DocumentSnapshot,
  type MapPatchInput,
  type MappedPatch,
} from './apply.js'

export {
  ToolRegistry,
  DuplicateToolError,
  InvalidToolNameError,
  requiresConfirmation,
  validateToolInput,
  type ToolContext,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolInputProblem,
  type ToolKind,
  type ToolSchema,
  type ToolSchemaProperty,
} from './tools.js'

export { isTerminal, type AgentEvent, type AgentFailure } from './events.js'

export { RequestGate, type GateState } from './stream.js'

export type { AgentContext, AgentRequest, AgentRunHandle, AgentRuntime } from './runtime.js'
