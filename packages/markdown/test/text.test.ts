import { describe, expect, it } from 'vitest'
import { UnsupportedEncodingError, type TextFileMeta } from '@mosu/plugin-api'
import { applyEol, decodeText, detectEol, encodeText, normalizeEol } from '@mosu/markdown'

const utf8 = (s: string) => new TextEncoder().encode(s)

describe('detectEol', () => {
  it('识别纯 LF', () => {
    expect(detectEol('a\nb\nc')).toEqual({ eol: 'lf', mixedEol: false })
  })

  it('识别纯 CRLF', () => {
    expect(detectEol('a\r\nb\r\nc')).toEqual({ eol: 'crlf', mixedEol: false })
  })

  it('混合换行取多数并打上标记', () => {
    expect(detectEol('a\r\nb\r\nc\nd')).toEqual({ eol: 'crlf', mixedEol: true })
    expect(detectEol('a\nb\nc\r\nd')).toEqual({ eol: 'lf', mixedEol: true })
  })

  it('孤立的 \\r 也算混合', () => {
    expect(detectEol('a\rb')).toEqual({ eol: 'lf', mixedEol: true })
  })

  it('单行文件默认 LF', () => {
    expect(detectEol('只有一行')).toEqual({ eol: 'lf', mixedEol: false })
  })
})

describe('normalizeEol / applyEol', () => {
  it('缓冲区内一律是 \\n', () => {
    expect(normalizeEol('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('LF ↔ CRLF 可逆', () => {
    const text = 'a\nb\nc\n'
    expect(normalizeEol(applyEol(text, 'crlf'))).toBe(text)
    expect(applyEol(text, 'lf')).toBe(text)
  })
})

describe('decodeText', () => {
  it('无 BOM 的 UTF-8', () => {
    const { text, meta } = decodeText(utf8('# 标题\n正文'))
    expect(text).toBe('# 标题\n正文')
    expect(meta).toEqual({ encoding: 'utf8', eol: 'lf', mixedEol: false })
  })

  it('带 BOM 的 UTF-8：BOM 被剥离但记在 meta 里', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('hi\r\n')])
    const { text, meta } = decodeText(bytes)
    expect(text).toBe('hi\n')
    expect(meta.encoding).toBe('utf8-bom')
    expect(meta.eol).toBe('crlf')
  })

  it('UTF-16 LE with BOM', () => {
    const meta: TextFileMeta = { encoding: 'utf16le', eol: 'lf', mixedEol: false }
    const bytes = encodeText('中文\n', meta)
    expect(decodeText(bytes).text).toBe('中文\n')
    expect(decodeText(bytes).meta.encoding).toBe('utf16le')
  })

  it('UTF-16 BE with BOM', () => {
    const meta: TextFileMeta = { encoding: 'utf16be', eol: 'lf', mixedEol: false }
    const bytes = encodeText('中文\n', meta)
    expect(decodeText(bytes).text).toBe('中文\n')
    expect(decodeText(bytes).meta.encoding).toBe('utf16be')
  })

  it('二进制内容被拒绝，而不是用替换字符糊过去', () => {
    // 用替换字符糊过去的后果是用户一保存就把文件损坏了
    expect(() => decodeText(new Uint8Array([0x00, 0x01, 0x02]))).toThrow(
      UnsupportedEncodingError,
    )
  })

  it('非法 UTF-8 字节序列被拒绝', () => {
    expect(() => decodeText(new Uint8Array([0xff, 0x00, 0xfe]))).toThrow(
      UnsupportedEncodingError,
    )
  })
})

describe('保真闭环：decode → encode 必须逐字节一致', () => {
  const samples: Array<[string, Uint8Array]> = [
    ['LF + UTF-8', utf8('# 标题\n\n正文 **粗体**\n')],
    ['CRLF + UTF-8', utf8('# 标题\r\n\r\n正文\r\n')],
    ['UTF-8 BOM + CRLF', new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('a\r\nb\r\n')])],
    ['无尾部换行', utf8('没有结尾换行')],
    ['多个尾部空行', utf8('a\n\n\n\n')],
    ['行尾空格（Markdown 的硬换行）', utf8('第一行  \n第二行\n')],
    ['emoji 与代理对', utf8('🎉 表情 𝄞 音符\n')],
    ['制表符缩进', utf8('- 项目\n\t- 子项\n')],
    ['空文件', new Uint8Array([])],
  ]

  for (const [name, bytes] of samples) {
    it(name, () => {
      const { text, meta } = decodeText(bytes)
      expect(encodeText(text, meta)).toEqual(bytes)
    })
  }

  it('混合换行是已知的例外：会被统一，且 meta 里必须标记出来', () => {
    const bytes = utf8('a\r\nb\nc\r\n')
    const { text, meta } = decodeText(bytes)
    expect(meta.mixedEol).toBe(true)
    // 统一成了 CRLF —— 这是设计上接受的损耗，UI 必须提示用户（docs/design/04 §2）
    expect(encodeText(text, meta)).toEqual(utf8('a\r\nb\r\nc\r\n'))
  })
})
