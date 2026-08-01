/**
 * HTML 实体解码。
 *
 * 为什么不上完整的 HTML5 实体表：那张表有 2000 多条、压缩后仍有几十 KB，
 * 而它服务的是「文档里偶尔出现 `&amp;`」这一件小事。这里收录的是**在
 * Markdown 正文里真会被手写出来**的那些 —— 剩下的走数字实体，
 * 或者原样保留。
 *
 * 原则 P2 在这里的具体含义：**认不出来就原样显示**。
 * 把 `&foo;` 显示成空白或问号，比显示 `&foo;` 糟糕得多。
 */

/** 命名实体。按用途分组，方便后来的人判断该不该往里加。 */
const NAMED: Record<string, string> = {
  // 必需的五个：Markdown/HTML 里绕不开
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",

  // 空白与连字
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '­',
  ndash: '–',
  mdash: '—',
  minus: '−',

  // 标点
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  dagger: '†',
  Dagger: '‡',
  prime: '′',
  Prime: '″',

  // 符号
  copy: '©',
  reg: '®',
  trade: '™',
  sect: '§',
  para: '¶',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  ne: '≠',
  le: '≤',
  ge: '≥',
  infin: '∞',
  micro: 'µ',
  permil: '‰',

  // 货币
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',

  // 箭头
  larr: '←',
  uarr: '↑',
  rarr: '→',
  darr: '↓',
  harr: '↔',
  lArr: '⇐',
  rArr: '⇒',
  hArr: '⇔',
}

const NAMED_RE = /^&([a-zA-Z][a-zA-Z0-9]*);$/
const DECIMAL_RE = /^&#(\d{1,7});$/
const HEX_RE = /^&#[xX]([0-9a-fA-F]{1,6});$/

/**
 * 把码点转成字符串，非法码点返回 null。
 *
 * 需要挡掉的三类：超出 Unicode 范围、代理对区间（单独出现是非法的）、
 * 以及 NUL —— CommonMark 规定 `&#0;` 解码为 U+FFFD，但在编辑器里
 * 让它保持原样更不容易让人困惑。
 */
function fromCodePoint(code: number): string | null {
  if (code <= 0 || code > 0x10ffff) return null
  if (code >= 0xd800 && code <= 0xdfff) return null
  return String.fromCodePoint(code)
}

/**
 * 解码单个实体（含首尾的 `&` 与 `;`）。
 *
 * 认不出来返回 null，调用方据此决定「原样显示」。
 */
export function decodeEntity(source: string): string | null {
  const named = NAMED_RE.exec(source)
  if (named) return NAMED[named[1] as string] ?? null

  const decimal = DECIMAL_RE.exec(source)
  if (decimal) return fromCodePoint(Number.parseInt(decimal[1] as string, 10))

  const hex = HEX_RE.exec(source)
  if (hex) return fromCodePoint(Number.parseInt(hex[1] as string, 16))

  return null
}
