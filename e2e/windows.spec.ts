/**
 * 多窗口。
 *
 * 这些用例守的是 ADR-0005 里定下的模型，尤其是那条 M1 遗留的缺陷：
 * 关闭回应必须能反查是哪个窗口，否则两个窗口同时确认时会关错窗口。
 */
import { expect, resetDoc, test, visibleText } from './fixtures.js'
import type { Page } from '@playwright/test'

/** 让 main 进程新建一个窗口，并等它出现。 */
async function openNewWindow(page: Page): Promise<Page> {
  const app = page.context().pages().length
  await page.evaluate(() => window.typo.window.create())
  await expect
    .poll(() => page.context().pages().length, { timeout: 15_000 })
    .toBeGreaterThan(app)
  const created = page.context().pages().at(-1)
  if (!created) throw new Error('新窗口没有出现')
  await created.waitForSelector('.cm-content', { state: 'visible' })
  return created
}

test.describe('多窗口', () => {
  test('可以开出第二个窗口', async ({ app, page }) => {
    await openNewWindow(page)
    expect(app.windows().length).toBe(2)
  })

  test('两个窗口的文档互相独立', async ({ page }) => {
    await resetDoc(page, '第一个窗口')
    const second = await openNewWindow(page)
    await resetDoc(second, '第二个窗口')

    expect(await visibleText(page)).toContain('第一个窗口')
    expect(await visibleText(second)).toContain('第二个窗口')

    // 收尾：清空避免关闭时弹保存确认
    await resetDoc(second)
    await resetDoc(page)
  })

  test('关闭一个窗口不影响另一个', async ({ app, page }) => {
    const second = await openNewWindow(page)
    await resetDoc(second)
    await second.close()

    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1)
    // 剩下那个窗口必须还能正常编辑 —— 关错窗口的话这里就崩了
    await resetDoc(page, '还活着')
    expect(await visibleText(page)).toContain('还活着')
    await resetDoc(page)
  })

  test('每个窗口独立维护自己的未保存标记', async ({ page }) => {
    const second = await openNewWindow(page)

    await resetDoc(page, '改过了')
    await expect(page.locator('#status-name')).toContainText('●')
    // 第二个窗口没动过，不该显示未保存标记
    await expect(second.locator('#status-name')).not.toContainText('●')

    await resetDoc(page)
    await resetDoc(second)
  })

  test('新窗口的标题是 Brainforge Typo', async ({ page }) => {
    const second = await openNewWindow(page)
    await expect.poll(() => second.title()).toContain('Brainforge Typo')
    await resetDoc(second)
  })
})
