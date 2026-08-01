/** 临时诊断（第四轮）：把 head 里那四样东西各自分开。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, expect, pasteText, test } from './fixtures.js'
import { contentStreams } from './pdf.js'

test('诊断4', async ({ app, page }) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'typo-dbg4-'))
  await pasteText(page, '占位')
  // 走一次真导出把目录授权下来
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

  const BODY = '<main><h1>标题</h1><p>正文一段</p></main>'
  const doc = (htmlAttr: string, head: string) =>
    `<!doctype html><html${htmlAttr}><head><meta charset="utf-8">${head}</head><body>${BODY}</body></html>`

  const probe = async (name: string, html: string): Promise<void> => {
    const f = path.join(dir, `${name}.pdf`)
    await page.evaluate(
      ([t, h]) => window.typo.fs.writePdf(t as string, h as string),
      [f, html],
    )
    const c = contentStreams(await readFile(f))
    console.log(`DBG4 [${name}] Tj=${/\bT[jJ]\b/.test(c)} 流长=${c.length}`)
  }

  await probe('a-基准', doc('', ''))
  await probe('b-只加lang', doc(' lang="zh-CN"', ''))
  await probe('c-只加title', doc('', '<title>未命名</title>'))
  await probe('d-只加generator', doc('', '<meta name="generator" content="Brainforge Typo">'))
  await probe(
    'e-只加viewport',
    doc('', '<meta name="viewport" content="width=device-width, initial-scale=1">'),
  )
  await probe('f-lang加title', doc(' lang="zh-CN"', '<title>未命名</title>'))
  await probe('g-英文title', doc('', '<title>untitled</title>'))

  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})
