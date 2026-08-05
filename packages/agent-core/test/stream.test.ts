/**
 * 「按 id 丢弃」的闸门。
 *
 * 这一组守的是 issue #39 那个形态的缺陷：上一次请求的结果被追加进了刚清空的
 * 列表。当时是在搜索面板里就地修的，没有单测；这次先有测试。
 */
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.js'
import { RequestGate } from '../src/stream.js'

const text = (requestId: string, delta: string): AgentEvent => ({
  type: 'text',
  requestId,
  delta,
})
const done = (requestId: string): AgentEvent => ({
  type: 'done',
  requestId,
  reason: 'complete',
})
const failed = (requestId: string): AgentEvent => ({
  type: 'failed',
  requestId,
  failure: { kind: 'offline' },
})

describe('RequestGate', () => {
  it('一开始什么都不收', () => {
    const gate = new RequestGate()
    expect(gate.state).toBe('idle')
    expect(gate.receive(text('a', 'hi'))).toEqual([])
  })

  it('id 还没回来时先缓冲，认下之后一次交出去', () => {
    const gate = new RequestGate()
    gate.open()
    expect(gate.state).toBe('awaiting')
    expect(gate.receive(text('a', '你'))).toEqual([])
    expect(gate.receive(text('a', '好'))).toEqual([])

    expect(gate.identify('a')).toEqual([text('a', '你'), text('a', '好')])
    expect(gate.state).toBe('active')
    expect(gate.requestId).toBe('a')
  })

  it('认下 id 之后的事件直接过', () => {
    const gate = new RequestGate()
    gate.open()
    gate.identify('a')
    expect(gate.receive(text('a', 'x'))).toEqual([text('a', 'x')])
  })

  it('上一次请求的尾巴被丢掉 —— 这就是 issue #39 的那个 bug', () => {
    const gate = new RequestGate()
    gate.open()
    gate.identify('a')
    gate.open() // 用户又问了一次
    gate.identify('b')
    expect(gate.receive(text('a', '上一轮的尾巴'))).toEqual([])
    expect(gate.receive(text('b', '这一轮的'))).toEqual([text('b', '这一轮的')])
  })

  it('缓冲期里混进来的旧 id 事件，认下新 id 时一并丢掉', () => {
    const gate = new RequestGate()
    gate.open()
    gate.receive(text('a', '旧的'))
    gate.receive(text('b', '新的'))
    expect(gate.identify('b')).toEqual([text('b', '新的')])
  })

  it('open 会把上一轮的缓冲清掉', () => {
    const gate = new RequestGate()
    gate.open()
    gate.receive(text('a', '旧的'))
    gate.open()
    expect(gate.identify('a')).toEqual([])
  })

  it.each([
    ['done', done],
    ['failed', failed],
  ])('收到 %s 之后自动关门，此后的事件一律丢掉', (_label, terminal) => {
    const gate = new RequestGate()
    gate.open()
    gate.identify('a')
    expect(gate.receive(terminal('a'))).toEqual([terminal('a')])
    expect(gate.state).toBe('idle')
    expect(gate.receive(text('a', '迟到的'))).toEqual([])
  })

  it('缓冲里就已经跑完了的请求，认下之后同样关门', () => {
    const gate = new RequestGate()
    gate.open()
    gate.receive(text('a', '全部'))
    gate.receive(done('a'))
    expect(gate.identify('a')).toEqual([text('a', '全部'), done('a')])
    expect(gate.state).toBe('idle')
  })

  it('用户在 invoke 回来之前就取消了 —— 那个 id 不该被认下', () => {
    const gate = new RequestGate()
    gate.open()
    gate.receive(text('a', '半句'))
    gate.close()

    expect(gate.identify('a')).toEqual([])
    expect(gate.state).toBe('idle')
    expect(gate.requestId).toBeNull()
    expect(gate.receive(text('a', '后半句'))).toEqual([])
  })

  it('取消之后再开一轮，一切从头来', () => {
    const gate = new RequestGate()
    gate.open()
    gate.identify('a')
    gate.close()
    gate.open()
    expect(gate.identify('b')).toEqual([])
    expect(gate.receive(text('b', '新的'))).toEqual([text('b', '新的')])
  })
})
