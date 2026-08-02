/**
 * ICU MessageFormat 的一个**子集**。
 *
 * ## 为什么不直接用 `intl-messageformat`
 *
 * 07 §4 定的是「UI 文案全部走 ICU MessageFormat」。这个库能完整实现 ICU，
 * 但它带着一个完整的表达式解析器，压缩后二十多 KB，而且要跟着 CLDR 数据一起走。
 * 我们整份文案里真正用到的语法只有两种：变量替换和复数。
 *
 * 所以这里手写这两种，**并且把「不支持」写成显式的规则而不是悄悄降级**：
 * 遇到不认识的语法就把原文吐出来，不猜、不抛错。翻译里写错一个花括号，
 * 表现是那一句显示成原样（一眼看得见），而不是整个面板白屏。
 *
 * 复数的类别选择走平台自带的 `Intl.PluralRules` —— 那是 CLDR 本体，
 * 比任何我们自己维护的表都准，而且不要钱。
 *
 * ## 支持的语法
 *
 * ```
 * 变量：  你好，{name}
 * 复数：  {n, plural, one {# file} other {# files}}
 * 转义：  '{' 不是占位符
 * ```
 *
 * 复数分支里的 `#` 会被替换成按区域格式化后的数字。
 */

/** 参数值。只允许字符串和数字 —— 别的东西进来大概率是调用方写错了。 */
export type MessageParams = Record<string, string | number>

/**
 * 把一条消息模板渲染成最终文本。
 *
 * 缺参数时保留原样的 `{name}`：这样漏传参数在界面上是看得见的，
 * 而换成空串会得到一句读起来通顺、意思却缺了一半的话 —— 那才是真的难查。
 */
export function formatMessage(
  template: string,
  params: MessageParams = {},
  locale = 'en',
): string {
  let out = ''
  let i = 0

  while (i < template.length) {
    const ch = template[i] as string

    // ICU 的转义：'{' 与 '}' 用单引号裹住。'' 表示一个字面单引号
    if (ch === "'") {
      const next = template[i + 1]
      if (next === "'") {
        out += "'"
        i += 2
        continue
      }
      if (next === '{' || next === '}') {
        const close = template.indexOf("'", i + 1)
        if (close > 0) {
          out += template.slice(i + 1, close)
          i = close + 1
          continue
        }
      }
      out += ch
      i++
      continue
    }

    if (ch !== '{') {
      out += ch
      i++
      continue
    }

    const end = matchBrace(template, i)
    if (end < 0) {
      // 没配对的花括号：原样输出剩下的全部，不再往下解析
      out += template.slice(i)
      break
    }

    out += renderArgument(template.slice(i + 1, end), params, locale)
    i = end + 1
  }

  return out
}

/** 从 `open`（指向 `{`）开始找配对的 `}`，返回它的下标；找不到返回 -1。 */
function matchBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 渲染一个 `{…}` 的内容（不含外层花括号）。 */
function renderArgument(body: string, params: MessageParams, locale: string): string {
  const comma = body.indexOf(',')

  if (comma < 0) {
    const name = body.trim()
    const value = params[name]
    return value === undefined ? `{${body}}` : String(value)
  }

  const name = body.slice(0, comma).trim()
  const rest = body.slice(comma + 1).trim()
  // 必须连逗号一起匹配：只判前缀的话 `{n, pluralize, …}` 也会被认成复数
  const head = /^plural\s*,/.exec(rest)
  if (!head) return `{${body}}` // 只认 plural，其余原样吐出

  const value = params[name]
  if (typeof value !== 'number') return `{${body}}`

  const branches = parseBranches(rest.slice(head[0].length))
  const category = new Intl.PluralRules(locale).select(value)
  const chosen = branches[`=${value}`] ?? branches[category] ?? branches['other']
  if (chosen === undefined) return `{${body}}`

  // `#` 是 ICU 里「当前这个数字」的写法，按区域格式化
  return formatMessage(
    chosen.split('#').join(new Intl.NumberFormat(locale).format(value)),
    params,
    locale,
  )
}

/** `one {…} other {…}` → `{ one: '…', other: '…' }`。 */
function parseBranches(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] as string)) i++
    const open = text.indexOf('{', i)
    if (open < 0) break
    const key = text.slice(i, open).trim()
    const close = matchBrace(text, open)
    if (close < 0) break
    out[key] = text.slice(open + 1, close)
    i = close + 1
  }
  return out
}
