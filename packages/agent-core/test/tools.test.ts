import { describe, expect, it, vi } from 'vitest'
import {
  DuplicateToolError,
  InvalidToolNameError,
  requiresConfirmation,
  ToolRegistry,
  validateToolInput,
  type ToolDefinition,
  type ToolSchema,
} from '../src/tools.js'

const noInput: ToolSchema = { type: 'object', properties: {}, additionalProperties: false }

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'getActiveDocument',
    kind: 'read',
    description: '拿到当前文档',
    input: noInput,
    run: vi.fn(async () => ({})),
    ...overrides,
  }
}

describe('ToolRegistry', () => {
  it('注册之后能取回来', () => {
    const registry = new ToolRegistry()
    const definition = tool()
    registry.register(definition)
    expect(registry.get('getActiveDocument')).toBe(definition)
    expect(registry.get('nope')).toBeUndefined()
  })

  it('重名当场抛错，不是「后一个盖掉前一个」', () => {
    const registry = new ToolRegistry()
    registry.register(tool())
    expect(() => registry.register(tool())).toThrow(DuplicateToolError)
  })

  it.each([['has.dot'], ['有中文'], [''], ['a'.repeat(65)], ['with space']])(
    '工具名 %j 不合法，注册时就拦下',
    (name) => {
      const registry = new ToolRegistry()
      expect(() => registry.register(tool({ name }))).toThrow(InvalidToolNameError)
    },
  )

  it.each([['searchWorkspace'], ['search_workspace'], ['search-workspace'], ['a'.repeat(64)]])(
    '工具名 %j 合法',
    (name) => {
      const registry = new ToolRegistry()
      expect(() => registry.register(tool({ name }))).not.toThrow()
    },
  )

  it('list 按注册顺序 —— 发给模型的清单顺序稳定，调试时的 diff 才读得懂', () => {
    const registry = new ToolRegistry()
    registry.register(tool({ name: 'c' }))
    registry.register(tool({ name: 'a' }))
    registry.register(tool({ name: 'b' }))
    expect(registry.list().map((t) => t.name)).toEqual(['c', 'a', 'b'])
  })

  it('describe 不把 run 交出去 —— 那份清单是要发给模型的', () => {
    const registry = new ToolRegistry()
    registry.register(tool())
    const [descriptor] = registry.describe()
    expect(descriptor).toEqual({
      name: 'getActiveDocument',
      description: '拿到当前文档',
      input: noInput,
    })
    expect(descriptor).not.toHaveProperty('run')
    expect(descriptor).not.toHaveProperty('kind')
  })
})

describe('requiresConfirmation', () => {
  it('写工具一律要确认，读工具一律不要', () => {
    expect(requiresConfirmation({ kind: 'write' })).toBe(true)
    expect(requiresConfirmation({ kind: 'read' })).toBe(false)
  })

  it('工具表里每一个写工具都会被要求确认 —— 这条是机械的，不靠人记', () => {
    const registry = new ToolRegistry()
    registry.register(tool({ name: 'readDocument', kind: 'read' }))
    registry.register(tool({ name: 'createDocument', kind: 'write' }))
    registry.register(tool({ name: 'renameDocument', kind: 'write' }))
    const unconfirmedWrites = registry
      .list()
      .filter((t) => t.kind === 'write' && !requiresConfirmation(t))
    expect(unconfirmedWrites).toEqual([])
  })
})

describe('validateToolInput', () => {
  const schema: ToolSchema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      scope: { type: 'string', enum: ['workspace', 'folder'] },
      limit: { type: 'number', minimum: 1, maximum: 100 },
      regex: { type: 'boolean' },
      paths: { type: 'array', items: { type: 'string' } },
    },
    required: ['query'],
    additionalProperties: false,
  }

  it('合法入参没有问题', () => {
    expect(
      validateToolInput(schema, {
        query: 'todo',
        scope: 'folder',
        limit: 20,
        regex: false,
        paths: ['a.md'],
      }),
    ).toEqual([])
  })

  it.each([[null], [42], ['string'], [['a']]])('%j 根本不是对象', (value) => {
    expect(validateToolInput(schema, value)).toEqual([{ kind: 'not-an-object' }])
  })

  it('少了必填字段', () => {
    expect(validateToolInput(schema, {})).toEqual([{ kind: 'missing', field: 'query' }])
  })

  it('必填字段显式给了 undefined 也算少', () => {
    expect(validateToolInput(schema, { query: undefined })).toEqual([
      { kind: 'missing', field: 'query' },
    ])
  })

  it('多出来的字段 —— 模型在编，不该悄悄放过去', () => {
    expect(validateToolInput(schema, { query: 'a', extra: 1 })).toEqual([
      { kind: 'unknown-field', field: 'extra' },
    ])
  })

  it('没写 additionalProperties: false 就不管多出来的字段', () => {
    const loose: ToolSchema = { type: 'object', properties: { a: { type: 'string' } } }
    expect(validateToolInput(loose, { a: 'x', b: 1 })).toEqual([])
  })

  it('类型不对', () => {
    expect(validateToolInput(schema, { query: 1 })).toEqual([
      { kind: 'wrong-type', field: 'query', expected: 'string' },
    ])
    expect(validateToolInput(schema, { query: 'a', regex: 'true' })).toEqual([
      { kind: 'wrong-type', field: 'regex', expected: 'boolean' },
    ])
  })

  it('不在枚举里', () => {
    expect(validateToolInput(schema, { query: 'a', scope: 'universe' })).toEqual([
      { kind: 'not-in-enum', field: 'scope', allowed: ['workspace', 'folder'] },
    ])
  })

  it('超出范围', () => {
    expect(validateToolInput(schema, { query: 'a', limit: 0 })).toEqual([
      { kind: 'out-of-range', field: 'limit' },
    ])
    expect(validateToolInput(schema, { query: 'a', limit: 101 })).toEqual([
      { kind: 'out-of-range', field: 'limit' },
    ])
  })

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY]])(
    '%j 的 typeof 是 number，但一路传下去会变成很贵的 bug',
    (limit) => {
      expect(validateToolInput(schema, { query: 'a', limit })).toEqual([
        { kind: 'wrong-type', field: 'limit', expected: 'number' },
      ])
    },
  )

  it('数组里混进非字符串', () => {
    expect(validateToolInput(schema, { query: 'a', paths: ['ok', 3] })).toEqual([
      { kind: 'wrong-type', field: 'paths', expected: 'array' },
    ])
  })

  it('问题全部列出来 —— 模型一次犯三个错是常事，一条一条退回去要跑三轮', () => {
    expect(validateToolInput(schema, { scope: 'universe', limit: 999, extra: true })).toEqual([
      { kind: 'missing', field: 'query' },
      { kind: 'not-in-enum', field: 'scope', allowed: ['workspace', 'folder'] },
      { kind: 'out-of-range', field: 'limit' },
      { kind: 'unknown-field', field: 'extra' },
    ])
  })
})
