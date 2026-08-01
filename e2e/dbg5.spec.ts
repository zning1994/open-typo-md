/**
 * 临时诊断（第五轮）：这次二分的对象是**真导出的那份 HTML**，不是我拼的。
 *
 * 前四轮里有一轮在合成文档上把 `lang` 指了出来，改掉之后产品路径依旧空白 ——
 * 说明合成文档复现的不是同一件事。所以这一轮先把真产物打出来（macOS 的 CI 日志
 * 是唯一能看见它的地方），再在**它自己**身上逐样去掉。定位完即删。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, expect, pasteText, test } from './fixtures.js'
import { contentStreams } from './pdf.js'

test('诊断5', async ({ app, page }) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'typo-dbg5-'))

  const save = async (target: string): Promise<void> => {
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
    }, target)
  }
  const waitFor = async (target: string): Promise<void> => {
    await expect
      .poll(
        () =>
          readFile(target)
            .then((b) => b.length)
            .catch(() => 0),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0)
  }

  await pasteText(page, '# 标题\n\n正文一段')

  // 1）真导出一次 PDF：既把目录授权下来，也复现基准症状
  const basePdf = path.join(dir, 'base.pdf')
  await save(basePdf)
  await clickMenu(app, ['文件', '导出为 PDF…'])
  await waitFor(basePdf)
  console.log(
    `DBG5 [真导出PDF] Tj=${/\bT[jJ]\b/.test(contentStreams(await readFile(basePdf)))}`,
  )

  // 2）真导出一次 HTML，拿到产品真正生成的那份文档
  const outHtml = path.join(dir, 'out.html')
  await save(outHtml)
  await clickMenu(app, ['文件', '导出为 HTML…'])
  await waitFor(outHtml)
  const html = await readFile(outHtml, 'utf8')

  // 整份打出来。没有公式没有图片，它应该只有两三 KB —— 这是唯一能看见
  // macOS 上主题变量实际算成了什么的机会
  console.log(`DBG5 ===== 产物 ${html.length} 字节 =====\n${html}\nDBG5 ===== 完 =====`)

  const probe = async (name: string, source: string): Promise<void> => {
    const f = path.join(dir, `${name}.pdf`)
    await page.evaluate(
      ([t, h]) => window.typo.fs.writePdf(t as string, h as string),
      [f, source],
    )
    const c = contentStreams(await readFile(f))
    console.log(`DBG5 [${name}] Tj=${/\bT[jJ]\b/.test(c)} 流长=${c.length}`)
  }

  const styleStart = html.indexOf('<style>') + '<style>'.length
  const styleEnd = html.indexOf('</style>')
  const styles = html.slice(styleStart, styleEnd)
  const withStyles = (css: string): string =>
    html.slice(0, styleStart) + css + html.slice(styleEnd)

  // 主题 CSS 是拼在兜底样式后面的，它自己也是一段 `:root { … }`
  const themeAt = styles.lastIndexOf(':root {')
  const baseCss = styles.slice(0, themeAt)
  const themeCss = styles.slice(themeAt)

  const body = html.slice(html.indexOf('<main>'), html.indexOf('</main>') + '</main>'.length)

  await probe('a-原样', html)
  await probe('b-去viewport', html.replace(/<meta name="viewport"[^>]*>/, ''))
  await probe('c-空style', withStyles(''))
  await probe('d-只留兜底样式', withStyles(baseCss))
  await probe('e-只留主题样式', withStyles(themeCss))
  await probe('f-去colorscheme', withStyles(styles.replace(/color-scheme:[^;]*;/g, '')))
  await probe('g-去fontfamily', withStyles(styles.replace(/font-family:[^;]*;/g, '')))
  await probe(
    'h-去color与background',
    withStyles(styles.replace(/\b(color|background):[^;]*;/g, '')),
  )
  await probe(
    'i-裸外壳只留正文',
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
  )

  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})
