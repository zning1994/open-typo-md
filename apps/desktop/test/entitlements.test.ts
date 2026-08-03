/**
 * macOS 签名用的 entitlements。
 *
 * 这两个文件的形式**不是风格问题，是能不能签名的问题**。`codesign
 * --entitlements` 那一头解析 plist 的不是 CFPropertyList，而是 AMFI 自带的
 * 一个解析器（内核 `OSUnserializeXML` 的变体），比标准 XML 严格得多。
 * 原来那两份带着大段注释、`<true />` 里有空格、没有 DOCTYPE —— `xmllint`
 * 判定完全良构，codesign 一句话打回：
 *
 *     Failed to parse entitlements: AMFIUnserializeXML: syntax error near line 15
 *
 * 而这件事只在**真正配了证书之后**才会发生：没有证书时 electron-builder
 * 跳过签名，这两个文件根本不会被读。也就是说它坏了半年也没人知道，直到第一次
 * 拿真证书发布 —— 那时代价是一轮十几分钟的发布流水线。
 *
 * 所以在这里用纯文本的方式钉住。要解释什么，写在 build/README.md 里。
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const BUILD = new URL('../build/', import.meta.url)
const FILES = ['entitlements.mac.plist', 'entitlements.mac.inherit.plist'] as const

const read = (name: string) => readFile(new URL(name, BUILD), 'utf8')

describe.each(FILES)('%s', (name) => {
  it('带 DOCTYPE 声明', async () => {
    expect(await read(name)).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"')
  })

  it('没有 XML 注释', async () => {
    // DOCTYPE 也是 `<!` 开头，所以只找注释的起始序列
    expect(await read(name)).not.toContain('<!--')
  })

  it('布尔值写成 <true/>，斜杠前不留空格', async () => {
    const source = await read(name)
    expect(source).toContain('<true/>')
    expect(source).not.toMatch(/<(true|false)\s+\/>/)
  })
})

describe('两份 entitlements', () => {
  it('豁免项完全一致 —— 签名是逐个 bundle 做的，主程序那份不会传给 Helper', async () => {
    // 少了这条一致性，表现是主进程起得来、渲染进程一开就崩，
    // 而那看起来完全不像签名问题
    const keysOf = (source: string) => source.match(/<key>[^<]+<\/key>/g) ?? []

    const [main, inherit] = await Promise.all(FILES.map(read))
    expect(keysOf(inherit)).toEqual(keysOf(main))
    expect(keysOf(main).length).toBeGreaterThan(0)
  })

  it('不含 com.apple.security.inherit —— 那是 App Sandbox 的键，这里不开沙盒', async () => {
    for (const source of await Promise.all(FILES.map(read))) {
      expect(source).not.toContain('com.apple.security.inherit')
    }
  })
})
