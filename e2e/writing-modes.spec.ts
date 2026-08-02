/**
 * 专注模式与打字机模式（docs/design/02 §8）。
 *
 * 单测已经覆盖了「哪一块算当前块」。这里验的是单测**不可能**覆盖的部分：
 * 变暗真的落到了 DOM 上、居中真的动了滚动条、开关在标签之间与重启之间还在。
 * 打字机模式尤其只能在这里测 —— 它的正确性完全由真实的行高与视口高度决定。
 */
import { ACTIVE_CONTENT, ACTIVE_PAGE, clickMenu, expect, resetDoc, test } from './fixtures.js'
import type { Page } from '@playwright/test'

/** 一篇长到必然要滚动的文档，段落都能一眼认出来。 */
function longDoc(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, i) => `第 ${i + 1} 段的内容`).join('\n\n')
}

async function paste(page: Page, text: string): Promise<void> {
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.evaluate((payload) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', payload)
    document
      .querySelector('.tab-page:not([hidden]) .cm-content')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
  }, text)
}

/** 当前变暗的行数。0 表示专注模式没开（或整篇都是当前块）。 */
function dimmed(page: Page) {
  return page.locator(`${ACTIVE_PAGE} .cm-mosu-dim`)
}

async function scrollTop(page: Page): Promise<number> {
  return page.locator(`${ACTIVE_PAGE} .cm-scroller`).evaluate((el) => el.scrollTop)
}

test.describe('专注模式', () => {
  test('打开后当前段以外的行变暗，关掉后一行都不剩', async ({ app, page }) => {
    await paste(page, '第一段\n\n第二段\n\n第三段')
    await expect(dimmed(page)).toHaveCount(0)

    await clickMenu(app, ['视图', '专注模式'])
    // 五行里当前段占一行，其余四行变暗
    await expect(dimmed(page)).toHaveCount(4)

    // 当前段本身不能带 dim —— 否则「专注」反而把要写的那段调暗了
    await expect(
      page.locator(`${ACTIVE_PAGE} .cm-line`).filter({ hasText: '第三段' }),
    ).not.toHaveClass(/cm-mosu-dim/)

    await clickMenu(app, ['视图', '专注模式'])
    await expect(dimmed(page)).toHaveCount(0)
  })

  test('光标换一段，变暗的范围跟着走', async ({ app, page }) => {
    await paste(page, '第一段\n\n第二段\n\n第三段')
    await clickMenu(app, ['视图', '专注模式'])

    await page.locator(`${ACTIVE_PAGE} .cm-line`).filter({ hasText: '第一段' }).click()
    await expect(
      page.locator(`${ACTIVE_PAGE} .cm-line`).filter({ hasText: '第一段' }),
    ).not.toHaveClass(/cm-mosu-dim/)
    await expect(
      page.locator(`${ACTIVE_PAGE} .cm-line`).filter({ hasText: '第三段' }),
    ).toHaveClass(/cm-mosu-dim/)

    await clickMenu(app, ['视图', '专注模式'])
  })

  test('新开的标签页直接带着专注模式，不用再开一次', async ({ app, page }) => {
    await paste(page, '第一段\n\n第二段')
    await clickMenu(app, ['视图', '专注模式'])
    await expect(dimmed(page)).toHaveCount(2)

    await clickMenu(app, ['文件', '新建标签页'])
    await paste(page, '甲\n\n乙\n\n丙')
    await expect(dimmed(page)).toHaveCount(4)

    await clickMenu(app, ['视图', '专注模式'])
    await resetDoc(page)
    await clickMenu(app, ['文件', '关闭标签页'])
  })
})

/**
 * 当前行的垂直中心离视口中心差多少像素。
 *
 * 刻意**不用 scrollTop 当代理指标**：打字机模式给正文加了 50vh 的上留白，
 * 文档第一行在 scrollTop=0 时本来就已经接近中央了，居中只会让它动半行高。
 * 「滚动条动了多少」跟「有没有居中」根本不是一回事，直接量位置才算数。
 */
async function offCenter(page: Page, text: string): Promise<number> {
  const scroller = await page.locator(`${ACTIVE_PAGE} .cm-scroller`).boundingBox()
  const line = await page
    .locator(`${ACTIVE_PAGE} .cm-line`)
    .filter({ hasText: text })
    .boundingBox()
  if (!scroller || !line) throw new Error(`量不到「${text}」的位置`)
  return Math.abs(line.y + line.height / 2 - (scroller.y + scroller.height / 2))
}

test.describe('打字机模式', () => {
  test('开启后当前行被拉到视口中央', async ({ app, page }) => {
    await paste(page, longDoc(80))
    await page.locator(ACTIVE_CONTENT).click()
    await page.keyboard.press('ControlOrMeta+Home')
    // 没开打字机模式时第一行贴在顶上 —— 先确认这个前提，
    // 否则「开启后居中」可能只是因为它本来就在中间
    expect(await offCenter(page, '第 1 段')).toBeGreaterThan(100)

    await clickMenu(app, ['视图', '打字机模式'])

    // 一行的高度量级是几十像素，40px 的容差足够宽松，又能挡住「其实没居中」
    await expect.poll(() => offCenter(page, '第 1 段')).toBeLessThan(40)

    await clickMenu(app, ['视图', '打字机模式'])
  })

  test('光标往下走时视图跟着走，当前行一直在中间', async ({ app, page }) => {
    await paste(page, longDoc(80))
    await page.locator(ACTIVE_CONTENT).click()
    await page.keyboard.press('ControlOrMeta+Home')
    await clickMenu(app, ['视图', '打字机模式'])
    await expect.poll(() => offCenter(page, '第 1 段')).toBeLessThan(40)

    const before = await scrollTop(page)
    // 段落之间有空行，所以 12 下方向键落在第 7 段上
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown')
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(before)
    await expect.poll(() => offCenter(page, '第 7 段')).toBeLessThan(40)

    await clickMenu(app, ['视图', '打字机模式'])
  })

  test('拖选时不抢滚动条', async ({ app, page }) => {
    await paste(page, longDoc(80))
    await page.locator(ACTIVE_CONTENT).click()
    await page.keyboard.press('ControlOrMeta+Home')
    await clickMenu(app, ['视图', '打字机模式'])
    await expect.poll(() => offCenter(page, '第 1 段')).toBeLessThan(40)

    const parked = await scrollTop(page)
    // 全选产生一个非空选区。此时如果还去居中，用户拖选一大段就会被拽回去
    await page.keyboard.press('ControlOrMeta+a')
    await page.waitForTimeout(200)
    expect(Math.abs((await scrollTop(page)) - parked)).toBeLessThan(4)

    await page.keyboard.press('ArrowLeft')
    await clickMenu(app, ['视图', '打字机模式'])
  })
})
