/**
 * 导出为 HTML 与复制为富文本（docs/design/06 §2）。
 *
 * 转换本身有 25 条单测（`packages/export`）。这里验的是**只有真应用里才成立**
 * 的那几件事：内联图片要过资源协议、KaTeX 的字体要 fetch 得到、
 * mermaid 要真渲染、剪贴板要真写进去 —— 每一条都可能被 CSP 或协议注册挡下来。
 *
 * 走的是真菜单项。唯一被替身顶掉的是 **Electron 自己的原生保存对话框**
 * （无头环境里没人能点它），不是我们的代码 —— 产品这一侧一行都没绕开。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, expect, resetDoc, test } from './fixtures.js'
import type { ElectronApplication } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mosu-export-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

/** 让原生保存对话框直接返回指定路径。 */
async function stubSaveDialog(app: ElectronApplication, target: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, target)
}

/** 触发导出并读回产物。 */
async function exportTo(app: ElectronApplication, target: string): Promise<string> {
  await stubSaveDialog(app, target)
  await clickMenu(app, ['文件', '导出为 HTML…'])
  await expect
    .poll(() => readFile(target, 'utf8').catch(() => ''), { timeout: 20_000 })
    .not.toBe('')
  return readFile(target, 'utf8')
}

test('导出的是完整的自包含文档', async ({ app, page }) => {
  await resetDoc(page, '# 标题\n\n**粗体**与 `代码`\n\n- 甲\n- 乙')
  const html = await exportTo(app, path.join(dir, 'out.html'))

  expect(html).toContain('<!doctype html>')
  expect(html).toContain('<h1>标题</h1>')
  expect(html).toContain('<strong>粗体</strong>')
  // 自包含的定义：没有任何外链
  expect(html).not.toContain('<link ')
  expect(html).not.toContain('<script ')
})

test('当前主题的配色被写进导出产物', async ({ app, page }) => {
  await resetDoc(page, '正文')
  const html = await exportTo(app, path.join(dir, 'themed.html'))

  expect(html).toContain('--mosu-bg:')
  expect(html).toContain('--mosu-fg:')
})

test('公式带上 KaTeX 样式，且字体是内联的', async ({ app, page }) => {
  // 字体不内联的话，公式在收件人机器上是一堆方框
  await resetDoc(page, '公式 $E = mc^2$ 在这\n\n第二段')
  await expect(page.locator('.cm-mosu-math .katex')).toHaveCount(1, { timeout: 20_000 })

  const html = await exportTo(app, path.join(dir, 'math.html'))
  expect(html).toContain('katex')
  expect(html).toContain('data:font')
  // 一个外链字体都不许剩
  expect(html).not.toMatch(/url\(\s*['"]?[^'")]*\.woff2/)
})

test('没有公式的文档不背 KaTeX 那几 MB', async ({ app, page }) => {
  // 那套样式带着二十来个 woff2 的 base64，几 MB 起步。一篇没有公式的文档背着它，
  // 产物大小要翻几十倍，而多出来的字节一个都用不上。
  await resetDoc(page, '# 标题\n\n正文一段')
  const html = await exportTo(app, path.join(dir, 'nomath.html'))

  expect(html).not.toContain('data:font')
  expect(html).not.toContain('katex')
})

test('mermaid 图表导出成内联 SVG', async ({ app, page }) => {
  await resetDoc(page, '前文\n\n```mermaid\ngraph TD\nA-->B\n```\n\n后文')
  await expect(page.locator('.cm-mosu-mermaid svg')).toHaveCount(1, { timeout: 30_000 })

  const html = await exportTo(app, path.join(dir, 'diagram.html'))
  expect(html).toContain('<svg')
  expect(html).toContain('mosu-diagram')
})

test('图片转成 data URI —— 自包含的关键一环', async ({ app, page }) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  await writeFile(path.join(dir, 'a.png'), png)
  const docPath = path.join(dir, 'doc.md')
  await writeFile(docPath, '![图](a.png)\n', 'utf8')

  const before = page.context().pages().length
  await page.evaluate((p) => window.mosu.window.create(p), docPath)
  await expect.poll(() => page.context().pages().length).toBeGreaterThan(before)
  const doc = page.context().pages().at(-1)!
  await doc.waitForSelector('.cm-content', { state: 'visible' })
  await expect.poll(() => doc.locator('.cm-content').textContent()).toContain('图')

  const html = await exportTo(app, path.join(dir, 'img.html'))
  expect(html).toContain('data:image/png;base64,')
  expect(html).not.toContain('src="a.png"')

  await resetDoc(doc)
})

test('文档里的 script 不会被带进导出产物', async ({ app, page }) => {
  // 导出产物是要发给别人的 —— 这条是安全底线
  await resetDoc(page, '正文\n\n<script>alert(1)</script>')
  const html = await exportTo(app, path.join(dir, 'safe.html'))

  expect(html).not.toContain('alert(1)')
  expect(html).not.toContain('<script>alert')
})

test('复制为富文本：HTML 与纯文本都写进剪贴板', async ({ app, page }) => {
  await resetDoc(page, '# 标题\n\n**粗体**')
  await clickMenu(app, ['编辑', '复制为富文本'])

  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readHTML()), { timeout: 15_000 })
    .toContain('<strong>粗体</strong>')

  // 纯文本兜底：目标应用不支持富文本时才有东西可粘
  const text = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(text).toContain('**粗体**')
})
