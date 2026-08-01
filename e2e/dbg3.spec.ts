/** 临时诊断（第三轮）：对文档做二分，找出到底是哪一段让 macOS 画不出字。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, docText, expect, pasteText, test } from './fixtures.js'
import { contentStreams } from './pdf.js'

test('诊断3', async ({ app, page }) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'typo-dbg3-'))
  await clickMenu(app, ['视图', '主题', '浅色'])
  await pasteText(page, '# 标题\n\n正文一段')
  // 先确认文档里真有东西 —— 空文档也会产出一页空白，那是另一回事
  console.log('DBG3 文档内容', JSON.stringify(await docText(page)))

  const htmlPath = path.join(dir, 'a.html')
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
  }, htmlPath)
  await clickMenu(app, ['文件', '导出为 HTML…'])
  await expect
    .poll(() => readFile(htmlPath, 'utf8').catch(() => ''), { timeout: 20_000 })
    .not.toBe('')
  const real = await readFile(htmlPath, 'utf8')
  console.log('DBG3 真产物长度', real.length, '含 h1:', real.includes('<h1>'))

  const probe = async (name: string, html: string): Promise<void> => {
    const f = path.join(dir, `${name}.pdf`)
    await page.evaluate(
      ([t, h]) => window.typo.fs.writePdf(t as string, h as string),
      [f, html],
    )
    const c = contentStreams(await readFile(f))
    console.log(`DBG3 [${name}] Tj=${/\bT[jJ]\b/.test(c)} 流长=${c.length}`)
  }

  const BODY = '<main><h1>标题</h1><p>正文一段</p></main>'
  await probe(
    '1-裸',
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${BODY}</body></html>`,
  )
  await probe(
    '2-带meta和title',
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="generator" content="Brainforge Typo"><title>未命名</title></head><body>${BODY}</body></html>`,
  )

  // 3：真产物，但把 <style> 整段挖掉
  const noStyle = real.replace(/<style>[\s\S]*?<\/style>/, '')
  await probe('3-真产物去掉style', noStyle)

  // 4：真产物，但只保留 style 的前半截（BASE_CSS），去掉主题那个 :root
  const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(real)
  const css = styleMatch?.[1] ?? ''
  const themeStart = css.lastIndexOf(':root {')
  await probe('4-只留BASE_CSS', real.replace(css, css.slice(0, themeStart)))

  // 5：真产物原样
  await probe('5-真产物', real)

  await clickMenu(app, ['视图', '主题', '跟随系统'])
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})
