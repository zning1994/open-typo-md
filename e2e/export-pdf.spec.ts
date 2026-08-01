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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, expect, pasteText, test } from './fixtures.js'
import { contentStreams, pageCount } from './pdf.js'
import type { ElectronApplication, Page } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'typo-pdf-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

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

test('产物是一份真的 PDF', async ({ app, page }) => {
  await pasteText(page, '# 标题\n\n正文一段')
  const pdf = await exportPdf(app, 'basic.pdf')

  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  expect(pageCount(pdf)).toBe(1)
})

test('正文确实画进了 PDF，不是一页空白', async ({ app, page }) => {
  // 这条曾经在 macOS 上红了六轮：版面照排、底色照画，就是一个字都没有。
  // 根因是正文字体栈里的 `system-ui`（06 §3.3）—— 所以它同时也是那条修法的
  // 回归守卫：字体栈一旦退回 system-ui，这里立刻变红。
  await pasteText(page, '# 标题\n\n正文一段')
  const content = contentStreams(await exportPdf(app, 'text.pdf'))

  // Tj / TJ 是 PDF 里绘制文字的指令
  expect(content).toMatch(/\bT[jJ]\b/)
})

/**
 * 下面两条把 `renderPdf`（main 侧那个隐藏窗口）从整条导出管线里**单独拎出来**测。
 *
 * 加它们是因为上面那条曾经在 macOS 上是空白页，而从产物看不出该怪谁：可能是
 * 隐藏窗口根本没绘制，可能是生成的 HTML 有问题，也可能是字体。喂一段写死的
 * HTML 进去就能把三者分开 —— 当时的读法是：
 *
 * - 两条都挂 → 隐藏窗口那一侧的问题；
 * - 只有中文那条挂 → 字体问题；
 * - 两条都过 → 问题出在我们生成的 HTML。
 *
 * 实际结果是「两条都过」，于是范围收到了生成的 HTML 上 —— 最终查出来是那份
 * HTML 里的字体栈（06 §3.3）。**中文那条现在是根因的直接守卫**：
 * 它一旦红了，就是中文字形又画不进 PDF 了。
 */
async function pdfFromHtml(page: Page, name: string, html: string): Promise<string> {
  const target = path.join(dir, name)
  await page.evaluate(
    ([file, source]) => window.typo.fs.writePdf(file as string, source as string),
    [target, html],
  )
  return contentStreams(await readFile(target))
}

const PLAIN_HTML = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body style="color:#000">${body}</body></html>`

test('renderPdf 能把一段写死的 HTML 画成 PDF', async ({ app, page }) => {
  // 先走一次正常导出，把目录授权下来 —— 授权只能由用户在系统对话框里给出
  await pasteText(page, '占位')
  await exportPdf(app, 'grant.pdf')

  const content = await pdfFromHtml(page, 'plain.pdf', PLAIN_HTML('<h1>HELLO</h1><p>plain</p>'))
  expect(content).toMatch(/\bT[jJ]\b/)
})

test('中文也画得进 PDF', async ({ app, page }) => {
  await pasteText(page, '占位')
  await exportPdf(app, 'grant2.pdf')

  const content = await pdfFromHtml(page, 'cjk.pdf', PLAIN_HTML('<h1>中文标题</h1>'))
  expect(content).toMatch(/\bT[jJ]\b/)
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
