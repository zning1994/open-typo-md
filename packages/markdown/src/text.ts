/**
 * 文本文件保真编解码。
 *
 * 目标 G2 的一半靠架构（缓冲区即文件内容），另一半靠这个文件：
 * 打开时把编码、BOM、换行风格记下来，保存时原样还原。
 *
 * 缓冲区内一律用 \n —— CodeMirror 的 Text 以 \n 切行，把 \r 留在行尾会引发
 * 一连串光标与选区的诡异行为。所以换行符的转换必须发生在这一层，
 * 而且必须是可逆的。
 */
import {
  UnsupportedEncodingError,
  type Encoding,
  type Eol,
  type TextFileMeta,
} from '@mosu/plugin-api'

const BOM_UTF8 = [0xef, 0xbb, 0xbf]
const BOM_UTF16LE = [0xff, 0xfe]
const BOM_UTF16BE = [0xfe, 0xff]

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false
  return sig.every((b, i) => bytes[i] === b)
}

/**
 * 判定换行风格。
 *
 * 已知限制：只区分 lf / crlf 两种，孤立的 \r（经典 Mac）被并入 lf 并标记为 mixed。
 * mixedEol 为 true 时，保存会把全文统一成 `eol`，调用方必须提示用户。
 */
export function detectEol(text: string): { eol: Eol; mixedEol: boolean } {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++
    else lf++
  }
  const loneCr = /\r(?!\n)/.test(text)
  if (crlf === 0 && lf === 0) return { eol: 'lf', mixedEol: loneCr }
  return { eol: crlf > lf ? 'crlf' : 'lf', mixedEol: (crlf > 0 && lf > 0) || loneCr }
}

/** 一切换行符 → \n。 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** \n → 目标换行符。输入必须是已归一化的文本。 */
export function applyEol(text: string, eol: Eol): string {
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

function decodeWith(bytes: Uint8Array, label: string, offset: number): string {
  const decoder = new TextDecoder(label, { fatal: true })
  return decoder.decode(bytes.subarray(offset))
}

/**
 * 把磁盘字节解成缓冲区文本 + 保真元数据。
 *
 * 无法解码（二进制、不支持的遗留编码）时抛 UnsupportedEncodingError，
 * 而不是用替换字符糊过去 —— 那样用户一保存就会把文件损坏。
 */
export function decodeText(
  bytes: Uint8Array,
  path = '<buffer>',
): {
  text: string
  meta: TextFileMeta
} {
  let raw: string
  let encoding: Encoding

  try {
    if (startsWith(bytes, BOM_UTF8)) {
      encoding = 'utf8-bom'
      raw = decodeWith(bytes, 'utf-8', 3)
    } else if (startsWith(bytes, BOM_UTF16LE)) {
      encoding = 'utf16le'
      raw = decodeWith(bytes, 'utf-16le', 2)
    } else if (startsWith(bytes, BOM_UTF16BE)) {
      encoding = 'utf16be'
      raw = decodeWith(bytes, 'utf-16be', 2)
    } else {
      encoding = 'utf8'
      raw = decodeWith(bytes, 'utf-8', 0)
    }
  } catch {
    throw new UnsupportedEncodingError(path)
  }

  // 无 BOM 的 UTF-16 会被当成「合法但满是 NUL 的 UTF-8」解出来，因此单独挡一道。
  // 同时这也挡住了伪装成 .md 的二进制文件。
  if (raw.includes('\u0000')) throw new UnsupportedEncodingError(path)

  const { eol, mixedEol } = detectEol(raw)
  return { text: normalizeEol(raw), meta: { encoding, eol, mixedEol } }
}

/** 缓冲区文本 → 磁盘字节。decodeText 的逆运算。 */
export function encodeText(text: string, meta: TextFileMeta): Uint8Array {
  const withEol = applyEol(text, meta.eol)

  switch (meta.encoding) {
    case 'utf8':
      return new TextEncoder().encode(withEol)
    case 'utf8-bom': {
      const body = new TextEncoder().encode(withEol)
      const out = new Uint8Array(body.length + 3)
      out.set(BOM_UTF8, 0)
      out.set(body, 3)
      return out
    }
    case 'utf16le':
    case 'utf16be': {
      const little = meta.encoding === 'utf16le'
      const out = new Uint8Array(2 + withEol.length * 2)
      out.set(little ? BOM_UTF16LE : BOM_UTF16BE, 0)
      const view = new DataView(out.buffer)
      for (let i = 0; i < withEol.length; i++) {
        view.setUint16(2 + i * 2, withEol.charCodeAt(i), little)
      }
      return out
    }
  }
}
