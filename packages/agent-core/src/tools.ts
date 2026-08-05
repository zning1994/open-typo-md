/**
 * Tool Registry：AI 与编辑器之间的**唯一**接口（ADR-0006 D3 / 不变量 3）。
 *
 * ## 它不是一层新的安全边界
 *
 * 这一点最容易看反。工具的实现里没有一行新的权限判断 —— 它们调的是已经在用的
 * 那三条许可（04 §1.2）：
 *
 * | 许可 | 建于 | 给谁用 |
 * | --- | --- | --- |
 * | `assertAllowed` | M0 | 读文件 |
 * | `assertAllowedDirectory` | M4.5 | 列目录 |
 * | `assertWritableInWorkspace` | issue #36 | 工作区内的写 |
 *
 * Registry 做的事只有一件：**把这三条许可暴露给一个新的调用方**。它的价值在于
 * 「只有这几个工具」这件事本身，不在于它自己又验了一遍。
 *
 * 真正新增的风险是调用方变成了模型 —— 提示注入，见 10 §6。
 *
 * ## 为什么没有 `confirm` 字段
 *
 * 设计文档最初写的是 `confirm?: 'never' | 'always'`，读类填 never、写类填 always。
 * 那是一条**要靠人记住**的规矩，而它只要漏一次就是「AI 悄悄建了个文件」。
 *
 * 现在只有 `kind: 'read' | 'write'`，要不要确认由 `requiresConfirmation()` 推出来。
 * 于是「注册一个不需要确认的写工具」在类型上就不存在。规矩要定成机械可检查的
 * 边界，不是「小心点用」（01 §5.1 是同一条教训）。
 */

/**
 * 工具入参的 schema。
 *
 * **刻意只覆盖一个子集**：对象、字符串、数字、布尔、枚举、字符串数组。
 * 完整实现一份 JSON Schema 是一个依赖（以及一整套边角），而这些 schema
 * 全部是我们自己写的 —— 需要更多表达力时该做的是把工具拆简单，不是把校验器做复杂。
 *
 * 顶层钉死成 `object`：各家 Provider 的工具调用协议都要求如此。
 */
export interface ToolSchema {
  type: 'object'
  properties: Record<string, ToolSchemaProperty>
  required?: string[]
  /** 只允许 false —— 多出来的字段一律是模型在编，不该悄悄放过去 */
  additionalProperties?: false
}

export type ToolSchemaProperty =
  | { type: 'string'; description?: string; enum?: string[] }
  | { type: 'number'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: { type: 'string' } }

/** 读工具不改任何东西；写工具会，且**一律**要用户确认。 */
export type ToolKind = 'read' | 'write'

export interface ToolContext {
  /** 这次工具调用属于哪一次请求。日志与「按 id 丢弃」都要它（10 §8） */
  requestId: string
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string
  kind: ToolKind
  /** 给模型看的一句话。它决定模型会不会在该用的时候用它 */
  description: string
  input: ToolSchema
  run(input: Input, context: ToolContext): Promise<Output>
}

/** 发给模型的那一份：只有名字、说明、入参 schema，**没有 `run`**。 */
export interface ToolDescriptor {
  name: string
  description: string
  input: ToolSchema
}

export function requiresConfirmation(tool: Pick<ToolDefinition, 'kind'>): boolean {
  return tool.kind === 'write'
}

/**
 * 各家 Provider 对工具名的要求交集：`^[a-zA-Z0-9_-]{1,64}$`。
 *
 * 在注册时卡掉，而不是等到第一次真的发请求 —— 后者的失败长成「provider 返回
 * 400，报文里说某个字段不合法」，从那儿反推回「工具名里有个点」要花上不少时间。
 */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

export class DuplicateToolError extends Error {
  constructor(readonly toolName: string) {
    super(`工具 ${toolName} 已经注册过了`)
    this.name = 'DuplicateToolError'
  }
}

export class InvalidToolNameError extends Error {
  constructor(readonly toolName: string) {
    super(`工具名 ${JSON.stringify(toolName)} 不符合 ${String(TOOL_NAME)}`)
    this.name = 'InvalidToolNameError'
  }
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>()

  /**
   * 注册失败**抛异常**，跟 Patch 校验那边刻意相反。
   *
   * 区别在于输入是谁给的：Patch 来自模型，失败是常态；工具表是我们自己写的，
   * 注册两个同名工具是代码写错了，该在启动时当场炸掉，而不是留一个「后一个把
   * 前一个盖掉」的静默行为。
   */
  register<Input, Output>(tool: ToolDefinition<Input, Output>): void {
    if (!TOOL_NAME.test(tool.name)) throw new InvalidToolNameError(tool.name)
    if (this.#tools.has(tool.name)) throw new DuplicateToolError(tool.name)
    this.#tools.set(tool.name, tool as ToolDefinition)
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name)
  }

  /** 按注册顺序。发给模型的清单顺序稳定，调试时的 diff 才读得懂 */
  list(): ToolDefinition[] {
    return [...this.#tools.values()]
  }

  describe(): ToolDescriptor[] {
    return this.list().map(({ name, description, input }) => ({ name, description, input }))
  }
}

export type ToolInputProblem =
  | { kind: 'not-an-object' }
  | { kind: 'missing'; field: string }
  | { kind: 'unknown-field'; field: string }
  | { kind: 'wrong-type'; field: string; expected: ToolSchemaProperty['type'] }
  | { kind: 'not-in-enum'; field: string; allowed: string[] }
  | { kind: 'out-of-range'; field: string }

/**
 * 校验模型给的入参。返回空数组表示可以调。
 *
 * 跟 Patch 校验一样**列全部问题、不抛异常**：这是模型输出与我们的代码接壤的那
 * 一处，失败是常态。把问题原样退回去，模型下一轮往往就改对了。
 */
export function validateToolInput(schema: ToolSchema, value: unknown): ToolInputProblem[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ kind: 'not-an-object' }]
  }
  const input = value as Record<string, unknown>
  const problems: ToolInputProblem[] = []

  for (const field of schema.required ?? []) {
    if (!(field in input) || input[field] === undefined) {
      problems.push({ kind: 'missing', field })
    }
  }

  for (const [field, given] of Object.entries(input)) {
    const property = schema.properties[field]
    if (!property) {
      if (schema.additionalProperties === false) {
        problems.push({ kind: 'unknown-field', field })
      }
      continue
    }
    if (given === undefined) continue
    problems.push(...checkProperty(field, property, given))
  }

  return problems
}

function checkProperty(
  field: string,
  property: ToolSchemaProperty,
  given: unknown,
): ToolInputProblem[] {
  switch (property.type) {
    case 'string': {
      if (typeof given !== 'string') return [{ kind: 'wrong-type', field, expected: 'string' }]
      if (property.enum && !property.enum.includes(given)) {
        return [{ kind: 'not-in-enum', field, allowed: property.enum }]
      }
      return []
    }
    case 'number': {
      // NaN / Infinity 也挡掉：它们 typeof 是 number，但一路传到下游会变成
      // 「切片长度是 NaN」这类查起来很贵的东西
      if (typeof given !== 'number' || !Number.isFinite(given)) {
        return [{ kind: 'wrong-type', field, expected: 'number' }]
      }
      const belowMin = property.minimum !== undefined && given < property.minimum
      const aboveMax = property.maximum !== undefined && given > property.maximum
      return belowMin || aboveMax ? [{ kind: 'out-of-range', field }] : []
    }
    case 'boolean': {
      return typeof given === 'boolean'
        ? []
        : [{ kind: 'wrong-type', field, expected: 'boolean' }]
    }
    case 'array': {
      if (!Array.isArray(given)) return [{ kind: 'wrong-type', field, expected: 'array' }]
      return given.every((item) => typeof item === 'string')
        ? []
        : [{ kind: 'wrong-type', field, expected: 'array' }]
    }
  }
}
