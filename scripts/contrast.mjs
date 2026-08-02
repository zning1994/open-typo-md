/**
 * 算主题变量之间的对比度（WCAG 相对亮度公式）。
 *
 *     node scripts/contrast.mjs
 *
 * ## 为什么值得有这么个东西
 *
 * axe 能在 E2E 里抓到违规，但它一次只看**当前那套主题、当前那个页面**上真实
 * 出现过的组合。六套主题 × 十来个前景色 × 三种背景，靠一条条跑 E2E 去覆盖是
 * 不现实的；而调色时最需要知道的恰恰是「我把这个值改成这样，还够不够」。
 *
 * 所以这个脚本直接读 `themes.css`，把该配对的组合全算一遍。它不进 CI 门槛
 * （E2E 里的 axe 才是门槛），它是**调色时的尺子**。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cssFile = path.join(repoRoot, 'apps/desktop/src/renderer/themes.css')

/** 要检查的「前景 on 背景」组合。 */
const PAIRS = [
  ['fg', 'bg'],
  ['fg-muted', 'bg'],
  ['fg-muted', 'status-bg'],
  ['fg', 'status-bg'],
  ['accent', 'bg'],
  ['danger', 'bg'],
  ['marker-fg', 'bg'],
  ['string-fg', 'code-bg'],
  ['number-fg', 'code-bg'],
  ['type-fg', 'code-bg'],
]

/** WCAG AA 对正文的要求。大字号（≥18.66px 粗体 / 24px）是 3.0，这里一律按严的算。 */
const AA = 4.5

function channel(value) {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim())
  if (!m) return null
  const [r, g, b] = m.slice(1).map((h) => channel(parseInt(h, 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  if (a === null || b === null) return null
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * 把 themes.css 拆成「主题 → 变量表」。
 *
 * 每个主题只写了跟基准不同的那些变量，所以每一套都要先继承 `:root` 那份。
 * 不继承的话，深色主题会因为「没重新声明 code-bg」而算不出结果 ——
 * 而那正好是最容易出问题的那类组合。
 */
async function parseThemes() {
  const css = await readFile(cssFile, 'utf8')
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]

  const themes = new Map()
  let base = {}

  for (const [, rawSelector, body] of blocks) {
    const selector = rawSelector.trim()
    const vars = {}
    for (const [, name, value] of body.matchAll(/--mosu-([\w-]+)\s*:\s*([^;]+);/g)) {
      vars[name] = value.trim()
    }
    if (Object.keys(vars).length === 0) continue

    if (selector === ':root') {
      base = { ...base, ...vars }
      continue
    }
    const named = /\[data-mosu-theme='([\w-]+)'\]/.exec(selector)
    if (!named) continue
    // 同一个主题可能被拆成几段（比如 auto 的 dark 分支），合并
    const id = named[1]
    themes.set(id, { ...(themes.get(id) ?? {}), ...vars })
  }

  const out = new Map([['default (light)', base]])
  for (const [id, vars] of themes) out.set(id, { ...base, ...vars })
  return out
}

const themes = await parseThemes()
let failures = 0

for (const [name, vars] of themes) {
  const rows = []
  for (const [fg, bg] of PAIRS) {
    const r = ratio(vars[fg] ?? '', vars[bg] ?? '')
    if (r === null) continue
    const ok = r >= AA
    if (!ok) failures++
    rows.push(`  ${ok ? '✓' : '✗'} ${fg} on ${bg}: ${r.toFixed(2)}`)
  }
  console.log(`\n[${name}]`)
  console.log(rows.join('\n'))
}

console.log(`\n共 ${failures} 组不足 ${AA}:1。`)
