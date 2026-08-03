/**
 * 长内容表格不把列撑出视口（issue #35）。
 *
 * 必须是 E2E：表格宽度由**匿名表格盒的自动布局**算出来（见
 * live-preview/tables.ts），而那是纯浏览器行为，单测里量不到。
 *
 * 缺陷的成因是 `.cm-mosu-tr` 上的 `white-space: pre` —— 单元格不折行，
 * 于是每列的最小内容宽度就是它最长那格的整行长度，自动布局把表撑到多宽
 * 都不算越界。修法是让单元格能折行（含长 URL 与不带空格的长标识符），
 * 最小内容宽度塌下来之后，收缩到可用宽度是自动布局本来就会做的事。
 *
 * 用例里的长内容**必须包含不易断行的东西**（长 URL、长标识符）——
 * 只放中文和英文单词的话，普通折行就够了，`overflow-wrap` 那一半白写。
 */
import { ACTIVE_CONTENT, expect, test } from './fixtures.js'
import type { Page } from '@playwright/test'

const LONG_ID = 'verylongunbrokenidentifier_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const LONG_URL = 'https://example.com/a/very/long/path/that/keeps/going/and/going?q=1&r=2&s=3'

/** 5 列 9 行，每格都塞得下不了台。 */
function wideTable(): string {
  const cell = (r: number, c: number) =>
    `R${r}C${c} 这是一段较长的中文说明文字 with English words ${LONG_URL} ${LONG_ID}`

  const rows = [`| 列一 | 列二 | 列三 | 列四 | 列五 |`, `| --- | --- | --- | --- | --- |`]
  for (let r = 1; r <= 9; r++) {
    rows.push(`| ${[1, 2, 3, 4, 5].map((c) => cell(r, c)).join(' | ')} |`)
  }
  return `# 长表格\n\n${rows.join('\n')}\n\n表格后面的正文。\n`
}

async function paste(page: Page, text: string): Promise<void> {
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.evaluate((doc) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', doc)
    document
      .querySelector('.tab-page:not([hidden]) .cm-content')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
  }, text)
  await page.waitForTimeout(500)
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('.tab-page:not([hidden])') as HTMLElement
    const scroller = root.querySelector('.cm-scroller') as HTMLElement
    const rows = [...root.querySelectorAll('.cm-mosu-tr')] as HTMLElement[]
    const cells = [...root.querySelectorAll('.cm-mosu-td')] as HTMLElement[]
    const box = scroller.getBoundingClientRect()

    return {
      rows: rows.length,
      // 视口获得横向滚动空间 == 有东西被撑到窗口外面去了
      scrollerOverflow: Math.round(scroller.scrollWidth - scroller.clientWidth),
      // 最靠右的单元格右边界。超出滚动区右沿就是「右侧列看不见」
      rightMost: Math.round(Math.max(...cells.map((c) => c.getBoundingClientRect().right))),
      viewportRight: Math.round(box.right),
      // 折行生效的话，一行的高度会明显超过单行
      tallestRow: Math.round(Math.max(...rows.map((r) => r.getBoundingClientRect().height))),
    }
  })
}

test.describe('长内容表格（#35）', () => {
  test('表格不把列撑出视口', async ({ page }) => {
    await paste(page, wideTable())
    const g = await geometry(page)

    expect(g.rows).toBeGreaterThan(0)
    // 1px 的余量给亚像素舍入，别放宽到几十 —— 缺陷发生时这个数是几千
    expect(g.scrollerOverflow).toBeLessThanOrEqual(1)
    expect(g.rightMost).toBeLessThanOrEqual(g.viewportRight)
  })

  test('长内容在单元格里折行，而不是延伸到窗口外', async ({ page }) => {
    await paste(page, wideTable())
    const g = await geometry(page)

    // 每格几十上百个字符挤进五分之一的正文宽度，折不了行就只能是单行。
    // 阈值取三行高（默认 16px × 1.7 ≈ 27px）—— 定得住，又不至于把
    // 「折了但折得不多」判成失败
    expect(g.tallestRow).toBeGreaterThan(80)
  })
})

// 这里原先还有一条「表格后面的正文仍在表格下方、左边界对齐」。
// 删掉了：对着**未修复**的代码它也是绿的 —— 匿名表格盒撑宽时往右溢出，
// 后续段落的左边界和上下顺序根本不受影响。一条不会失败的用例比没有更糟，
// 它还占着「这里已经测过了」的位置。表格的基本布局由 tables.spec.ts 守。
