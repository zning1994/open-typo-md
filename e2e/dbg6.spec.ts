/**
 * 临时诊断（第六轮）：把「字体」与「文字是哪种文种」交叉起来。
 *
 * 第五轮把范围收到了 `font-family` 上：去掉它就画得出字。但换成具名字体
 * （Helvetica…）之后**依旧空白** —— 所以不是「system-ui 有毒」这么简单。
 *
 * 一个够解释所有已知现象的猜测：产品的用例正文是**中文**，而拉丁字体栈里没有
 * 中日韩字形，Chromium 会逐字回退到系统的中文字体；没写 `font-family` 时它挑的
 * 是另一个。也就是说，坏的可能是**回退挑中的那个中文字体**，跟拉丁那一半无关。
 *
 * 所以这一轮不猜，直接把（字体 × 文种）铺开量一遍。定位完即删。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, expect, pasteText, test } from './fixtures.js'
import { contentStreams } from './pdf.js'

const FONTS: Array<[string, string]> = [
  ['无', ''],
  ['产品当前栈', "Helvetica, Arial, 'Liberation Sans', 'Nimbus Sans', sans-serif"],
  ['system-ui', 'system-ui'],
  ['apple-system', '-apple-system'],
  ['Helvetica', 'Helvetica'],
  ['Arial', 'Arial'],
  ['Times', 'Times'],
  ['sans-serif', 'sans-serif'],
  ['serif', 'serif'],
  ['PingFang', "'PingFang SC'"],
  ['Hiragino', "'Hiragino Sans GB'"],
  ['Songti', "'Songti SC'"],
  ['STHeiti', "'STHeiti'"],
  ['Arial+PingFang', "Arial, 'PingFang SC'"],
  ['Arial+Songti', "Arial, 'Songti SC'"],
]

const BODIES: Array<[string, string]> = [
  ['拉丁', '<h1>HELLO</h1><p>plain text</p>'],
  ['中文', '<h1>标题</h1><p>正文一段</p>'],
]

test('诊断6', async ({ app, page }) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'typo-dbg6-'))

  // 先走一次真导出把目录授权下来 —— 授权只能由用户在系统对话框里给出
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

  let n = 0
  for (const [fontName, font] of FONTS) {
    for (const [scriptName, body] of BODIES) {
      const style = font ? `body{font-family:${font}}` : ''
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body style="color:#000">${body}</body></html>`
      const file = path.join(dir, `p${n++}.pdf`)
      await page.evaluate(
        ([t, h]) => window.typo.fs.writePdf(t as string, h as string),
        [file, html],
      )
      const content = contentStreams(await readFile(file))
      console.log(
        `DBG6 ${fontName} / ${scriptName}: Tj=${/\bT[jJ]\b/.test(content)} 流长=${content.length}`,
      )
    }
  }

  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})
