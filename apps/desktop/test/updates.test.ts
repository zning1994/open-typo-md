/**
 * 检查更新的两个纯函数（版本比较、响应解析）。
 *
 * 网络那一半由 e2e 覆盖（在 main 里顶掉 `net.fetch`）。这里测的是**错了也不会
 * 报错、只会安静给出错答案**的那部分 —— 尤其是版本比较：用字符串比大小的话
 * `'0.10.0' < '0.9.0'` 成立，于是发了 0.10.0 之后所有 0.9.x 的用户都会被告知
 * 「已是最新」，而且没有任何迹象。
 */
import { describe, expect, it } from 'vitest'
import { compareVersions, readRelease } from '../src/main/updates.js'

/** `a` 比 `b` 新。 */
const newer = (a: string, b: string) => compareVersions(a, b) > 0
const same = (a: string, b: string) => compareVersions(a, b) === 0

describe('版本比较', () => {
  it('按数值比而不是按字典序', () => {
    // 这一条就是整个函数存在的理由
    expect(newer('0.10.0', '0.9.0')).toBe(true)
    expect(newer('1.0.0', '0.99.99')).toBe(true)
    expect(newer('0.2.10', '0.2.9')).toBe(true)
  })

  it('三段都比', () => {
    expect(newer('1.2.3', '1.2.2')).toBe(true)
    expect(newer('1.3.0', '1.2.99')).toBe(true)
    expect(newer('2.0.0', '1.99.99')).toBe(true)
    expect(newer('1.2.2', '1.2.3')).toBe(false)
  })

  it('`v` 前缀无关紧要 —— tag 带 v，package.json 不带', () => {
    expect(same('v1.2.3', '1.2.3')).toBe(true)
    expect(newer('v0.2.0', '0.1.0')).toBe(true)
  })

  it('段数不齐时补零，`1.2` 就是 `1.2.0`', () => {
    expect(same('1.2', '1.2.0')).toBe(true)
    expect(newer('1.2.1', '1.2')).toBe(true)
  })

  it('预发布排在同版本正式版之前', () => {
    // 我们的流程不发预发布，但用户可能手动装过一个 —— 那时不该把它当成更新的
    expect(newer('1.0.0', '1.0.0-beta.1')).toBe(true)
    expect(newer('1.0.0-beta.1', '1.0.0')).toBe(false)
    expect(newer('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true)
  })

  it('乱七八糟的输入不抛异常', () => {
    // tag 是仓库里人手打的，什么都可能出现。判错好过崩掉
    expect(() => compareVersions('', '1.0.0')).not.toThrow()
    expect(() => compareVersions('release-2026', '1.0.0')).not.toThrow()
    expect(() => compareVersions('1.x.0', '1.0.0')).not.toThrow()
  })
})

describe('响应解析', () => {
  it('取出 tag 与页面地址', () => {
    expect(readRelease({ tag_name: 'v0.2.0', html_url: 'https://example.com/r/1' })).toEqual({
      tag: 'v0.2.0',
      url: 'https://example.com/r/1',
    })
  })

  it('缺字段就当查不到，不猜', () => {
    expect(readRelease({})).toBeNull()
    expect(readRelease({ tag_name: '' })).toBeNull()
    expect(readRelease({ tag_name: 42 })).toBeNull()
    expect(readRelease(null)).toBeNull()
    expect(readRelease('not json')).toBeNull()
  })

  it('只缺页面地址时仍然可用 —— 有个能打开的地方就行', () => {
    expect(readRelease({ tag_name: 'v1.0.0' })?.tag).toBe('v1.0.0')
    expect(readRelease({ tag_name: 'v1.0.0' })?.url).toMatch(/^https:\/\//)
  })
})
