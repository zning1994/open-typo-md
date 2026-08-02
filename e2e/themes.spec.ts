/**
 * 主题切换（docs/design/05 §1–§3）。
 *
 * 主题是纯 CSS，能验的只有一件事，但它是最要紧的那件：
 * **变量契约有没有被真正应用到编辑器上**。契约断了的表现是「换了主题，
 * 正文颜色没变」—— 而那恰恰是社区主题赖以生存的东西。
 */
import { expect, resetDoc, test } from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

async function pickTheme(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, name) => {
    const view = Menu.getApplicationMenu()?.items.find((i) => i.label === '视图')
    const themes = view?.submenu?.items.find((i) => i.label === '主题')
    const target = themes?.submenu?.items.find((i) => i.label === name)
    if (!target) throw new Error(`主题菜单里找不到「${name}」`)
    target.click()
  }, label)
}

/** 编辑器正文实际生效的前景色与背景色。 */
async function colors(page: Page): Promise<{ fg: string; bg: string }> {
  return page.evaluate(() => {
    const el = document.querySelector('.cm-editor') as HTMLElement
    const style = getComputedStyle(el)
    return { fg: style.color, bg: style.backgroundColor }
  })
}

test('切到深色后编辑器真的变深 —— 变量契约通到了内核', async ({ app, page }) => {
  await resetDoc(page, '正文')
  await pickTheme(app, '浅色')
  const light = await colors(page)

  await pickTheme(app, '深色')
  await expect.poll(() => colors(page).then((c) => c.bg)).not.toBe(light.bg)

  const dark = await colors(page)
  expect(dark.fg).not.toBe(light.fg)
})

test('五套内置主题各自给出不同的配色', async ({ app, page }) => {
  await resetDoc(page, '正文')

  const seen = new Set<string>()
  for (const label of ['浅色', '深色', '护眼（Sepia）', '高对比', 'GitHub']) {
    await pickTheme(app, label)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['mosuTheme']))
      .not.toBe(undefined)
    const { fg, bg } = await colors(page)
    seen.add(`${fg}|${bg}`)
  }
  // 浅色与 GitHub 的正文色接近但不相同；五套至少给出四种不同的组合
  expect(seen.size).toBeGreaterThanOrEqual(4)
})

test('主题挂在 <html> 上，主题作者据此覆盖', async ({ app, page }) => {
  await resetDoc(page, '正文')
  await pickTheme(app, '护眼（Sepia）')

  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset['mosuTheme']))
    .toBe('sepia')
})

test('选择会被记住 —— 新窗口沿用同一个主题', async ({ app, page }) => {
  await resetDoc(page, '正文')
  await pickTheme(app, '深色')

  const before = page.context().pages().length
  await page.evaluate(() => window.mosu.window.create())
  await expect.poll(() => page.context().pages().length).toBeGreaterThan(before)

  const created = page.context().pages().at(-1)!
  await created.waitForSelector('.cm-content', { state: 'visible' })
  await expect
    .poll(() => created.evaluate(() => document.documentElement.dataset['mosuTheme']))
    .toBe('dark')

  await resetDoc(created)
})

test('打印时回到浅色，界面元素不上纸', async ({ app, page }) => {
  // 深色主题打出来是一整页黑，既费墨又难读 —— 这是默认行为，不是建议
  await resetDoc(page, '正文')
  await pickTheme(app, '深色')

  await page.emulateMedia({ media: 'print' })
  const printed = await page.evaluate(() => ({
    bg: getComputedStyle(document.documentElement).getPropertyValue('--mosu-bg').trim(),
    statusBar: getComputedStyle(document.querySelector('.status-bar') as HTMLElement).display,
  }))
  await page.emulateMedia({ media: 'screen' })

  expect(printed.bg).toBe('#ffffff')
  expect(printed.statusBar).toBe('none')
})
