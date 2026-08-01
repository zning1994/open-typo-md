/** 临时诊断：定位 macOS 上 PDF 空白页的根因。定位完就删。 */
import { inflateSync } from 'node:zlib'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, expect, pasteText, test } from './fixtures.js'

const VARS = ['bg', 'fg', 'font-body', 'font-size', 'line-height', 'content-width']

function streams(buf: Buffer): string {
  const raw = buf.toString('latin1')
  const out: string[] = []
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const s = m.index + m[0].length
    const e = raw.indexOf('endstream', s)
    if (e < 0) continue
    try {
      out.push(inflateSync(Buffer.from(raw.slice(s, e), 'latin1')).toString('latin1'))
    } catch {
      /* */
    }
  }
  return out.join('\n')
}

test('诊断', async ({ app, page }) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'typo-dbg-'))
  // 走一次真导出把目录授权下来
  await pasteText(page, '占位')
  const grant = path.join(dir, 'g.pdf')
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
  }, grant)
  await clickMenu(app, ['文件', '导出为 PDF…'])
  await expect
    .poll(
      () =>
        readFile(grant)
          .then((b) => b.length)
          .catch(() => 0),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0)
  console.log(
    'DBG 真导出内容流长度',
    streams(await readFile(grant)).length,
    '有Tj:',
    /\bT[jJ]\b/.test(streams(await readFile(grant))),
  )

  const probe = await page.evaluate((names) => {
    const el = document.createElement('div')
    el.dataset['typoTheme'] = 'light'
    el.style.display = 'none'
    document.body.appendChild(el)
    const c = getComputedStyle(el)
    const out: Record<string, string> = {}
    for (const n of names) out[n] = c.getPropertyValue(`--typo-${n}`).trim()
    el.remove()
    return out
  }, VARS)
  console.log('DBG 探针', JSON.stringify(probe))

  const themeCss = `:root {\n${VARS.map((n) => (probe[n] ? `  --typo-${n}: ${probe[n]};` : ''))
    .filter(Boolean)
    .join('\n')}\n}`
  const doc = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
:root { --typo-content-width: 42em; color-scheme: light dark; }
body { margin:0; padding:2.5rem 1.5rem 6rem; font-family: var(--typo-font-body, system-ui, sans-serif);
 font-size: var(--typo-font-size, 16px); line-height: var(--typo-line-height, 1.7);
 color: var(--typo-fg, #24292f); background: var(--typo-bg, #fff); }
main { max-width: var(--typo-content-width); margin: 0 auto; }
${themeCss}
</style></head><body><main><h1>HELLO 标题</h1><p>正文</p></main></body></html>`

  const target = path.join(dir, 'themed.pdf')
  await page.evaluate(
    ([f, h]) => window.typo.fs.writePdf(f as string, h as string),
    [target, doc],
  )
  const content = streams(await readFile(target))
  console.log('DBG 带主题CSS 有Tj:', /\bT[jJ]\b/.test(content), '长度', content.length)
  console.log('DBG 片段', JSON.stringify(content.slice(0, 260)))

  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})
