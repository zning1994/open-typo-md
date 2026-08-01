/**
 * 导出为 PDF（docs/design/06 §3）。
 *
 * 这条管线自己不造分页 —— 它把 HTML 导出的产物交给 Chromium 打印。
 * 所以这里验的是**交接处**：产物是不是真的 PDF、分页有没有发生、
 * 主题有没有按打印的规矩来、图片和字体有没有跟着进去。
 *
 * 断言直接读 PDF 的内容流（Flate 解压后就是 PostScript 风格的绘制指令）。
 * 比「文件大于 0 字节」实在得多：填充色、页数、图片对象都能直接看见。
 */
import { inflateSync } from 'node:zlib'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, expect, pasteText, test } from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'typo-pdf-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

/** 解开 PDF 里所有 Flate 流，拼成一段可搜索的文本。 */
function contentStreams(buf: Buffer): string {
  const raw = buf.toString('latin1')
  const out: string[] = []
  const marker = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = marker.exec(raw))) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) continue
    try {
      out.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'))
    } catch {
      // 非 Flate 流（图片可能用别的滤镜），跳过
    }
  }
  return out.join('\n')
}

function pageCount(buf: Buffer): number {
  const counts = buf.toString('latin1').match(/\/Count\s+(\d+)/g) ?? []
  return Math.max(0, ...counts.map((c) => Number(c.replace(/\D/g, ''))))
}

async function exportPdf(app: ElectronApplication, name: string): Promise<Buffer> {
  const target = path.join(dir, name)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, target)
  await clickMenu(app, ['文件', '导出为 PDF…'])
  await expect
    .poll(
      () =>
        readFile(target)
          .then((b) => b.length)
          .catch(() => 0),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0)
  return readFile(target)
}

test('产物是一份真的 PDF，字体跟着嵌进去', async ({ app, page }) => {
  await pasteText(page, '# 标题\n\n正文一段')
  const pdf = await exportPdf(app, 'basic.pdf')

  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  // 字体不嵌的话，换一台没装同款字体的机器打开就是另一副样子
  expect(pdf.toString('latin1')).toContain('FontFile')
  expect(pageCount(pdf)).toBe(1)
})

test('长文档会分页 —— 分页交给 Chromium，但它确实发生了', async ({ app, page }) => {
  await pasteText(page, `# 标题\n\n${'很长的一段正文。'.repeat(500)}`)
  const pdf = await exportPdf(app, 'long.pdf')

  expect(pageCount(pdf)).toBeGreaterThan(1)
})

test('深色主题下导出的 PDF 仍然是浅色底', async ({ app, page }) => {
  // 深色主题打出来是一整页黑，既费墨也读不了。
  // 这跟应用自己的打印样式是同一条规矩，不是建议而是默认行为
  await clickMenu(app, ['视图', '主题', '深色'])
  await expect(page.locator('html')).toHaveAttribute('data-typo-theme', 'dark')

  await pasteText(page, '# 标题\n\n正文一段')
  const content = contentStreams(await exportPdf(app, 'dark.pdf'))

  // 页面底色的填充指令：浅色主题的 #ffffff → `1 1 1 rg`
  expect(content).toContain('1 1 1 rg')
  // 深色主题的 #0d1117 换算过来是 .051 .0667 .0902
  expect(content).not.toContain('.0902 rg')

  await clickMenu(app, ['视图', '主题', '跟随系统'])
})

test('图片进得了 PDF', async ({ app, page }) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  await writeFile(path.join(dir, 'a.png'), png)
  const docPath = path.join(dir, 'doc.md')
  await writeFile(docPath, '![图](a.png)\n', 'utf8')

  const before = page.context().pages().length
  await page.evaluate((p) => window.typo.window.create(p), docPath)
  await expect.poll(() => page.context().pages().length).toBeGreaterThan(before)
  const doc = page.context().pages().at(-1)!
  await doc.waitForSelector('.cm-content', { state: 'visible' })
  await expect.poll(() => doc.locator('.cm-content').textContent()).toContain('图')

  const pdf = await exportPdf(app, 'img.pdf')
  expect(pdf.toString('latin1')).toContain('/Subtype /Image')

  await resetIn(doc)
})

/** 关掉临时开的那个窗口留下的脏内容，免得关窗时弹原生对话框。 */
async function resetIn(target: Page): Promise<void> {
  await target.locator('.cm-content').click()
  await target.keyboard.press('ControlOrMeta+a')
  await target.keyboard.press('Backspace')
}
