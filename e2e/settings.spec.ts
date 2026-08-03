/**
 * 设置面板（docs/design/05 §4）。
 *
 * 校验逻辑有 13 条单测。这里验的是**改了之后真的算数**：
 * 主题当场变、PDF 的纸张真的传到了打印那一侧、默认视图模式只影响新标签。
 *
 * 「设置项能保存」这件事本身不值得单独测 —— 值得测的是它有没有作用到东西上。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  clickMenu,
  docText,
  expect,
  openSettings as openSettingsMenu,
  resetDoc,
  test,
} from './fixtures.js'
import { backgroundRect } from './pdf.js'
import type { ElectronApplication, Page } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mosu-settings-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

async function openSettings(app: ElectronApplication, page: Page): Promise<void> {
  // 菜单位置按平台不同（mac 在应用菜单，其它在「视图」），
  // 所以走 fixtures 里那份共享的 —— 写死一条路径只会让另一个平台的 CI 红
  await openSettingsMenu(app)
  await expect(page.locator('.mosu-settings')).toBeVisible()
}

/** 面板里某一行的控件。 */
function control(page: Page, label: string) {
  return page
    .locator('.mosu-settings__row')
    .filter({ hasText: label })
    .locator('.mosu-settings__control')
}

test('Esc 与点遮罩都能关，关掉之后焦点回编辑器', async ({ app, page }) => {
  await resetDoc(page, '正文')
  await openSettings(app, page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.mosu-settings')).toBeHidden()

  // 焦点丢在 body 上的话，用户下一次按键就没反应
  await page.keyboard.type('甲')
  expect(await docText(page)).toContain('甲')

  await openSettings(app, page)
  await page.locator('.mosu-settings').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('.mosu-settings')).toBeHidden()
  await resetDoc(page)
})

test('改主题当场生效', async ({ app, page }) => {
  await openSettings(app, page)
  await control(page, '主题').selectOption('dark')

  await expect(page.locator('html')).toHaveAttribute('data-mosu-theme', 'dark')
  await control(page, '主题').selectOption('auto')
  await page.keyboard.press('Escape')
})

test('恢复默认值把改动都收回去', async ({ app, page }) => {
  await openSettings(app, page)
  await control(page, '纸张').selectOption('Legal')
  await control(page, '横向').check()
  await expect(control(page, '纸张')).toHaveValue('Legal')

  await page.locator('.mosu-settings__reset').click()
  await expect(control(page, '纸张')).toHaveValue('A4')
  await expect(control(page, '横向')).not.toBeChecked()
  await page.keyboard.press('Escape')
})

test('页边距超出范围时被夹住，输入框跟着回显真实值', async ({ app, page }) => {
  await openSettings(app, page)
  const margin = control(page, '页边距')
  await margin.fill('99')
  await margin.blur()

  // 夹到上限而不是拒绝 —— 但输入框里不能留着那个假数字
  await expect(margin).toHaveValue('3')
  await page.locator('.mosu-settings__reset').click()
  await page.keyboard.press('Escape')
})

test('纸张设置真的传到了打印那一侧 —— 换成横向后页面变宽', async ({ app, page }) => {
  await resetDoc(page, '# 标题\n\n正文')

  const exportPdf = async (name: string): Promise<Buffer> => {
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

  const [portraitW, portraitH] = backgroundRect(await exportPdf('portrait.pdf'))
  expect(portraitH).toBeGreaterThan(portraitW)

  await openSettings(app, page)
  await control(page, '横向').check()
  await page.keyboard.press('Escape')

  const [landscapeW, landscapeH] = backgroundRect(await exportPdf('landscape.pdf'))
  expect(landscapeW).toBeGreaterThan(landscapeH)

  await openSettings(app, page)
  await page.locator('.mosu-settings__reset').click()
  await page.keyboard.press('Escape')
  await resetDoc(page)
})

test('默认视图模式只影响新标签，不动已经开着的', async ({ app, page }) => {
  await resetDoc(page, '# 标题')
  await expect(page.locator('#status-mode')).toHaveAttribute('aria-pressed', 'false')

  await openSettings(app, page)
  await control(page, '新标签页默认进源码模式').check()
  await page.keyboard.press('Escape')

  // 已经开着的这个标签仍然是实时预览 —— 改一个设置就把所有标签切一遍很吓人
  await expect(page.locator('#status-mode')).toHaveAttribute('aria-pressed', 'false')

  await clickMenu(app, ['文件', '新建标签页'])
  await expect(page.locator('#status-mode')).toHaveAttribute('aria-pressed', 'true')

  await openSettings(app, page)
  await page.locator('.mosu-settings__reset').click()
  await page.keyboard.press('Escape')
  await clickMenu(app, ['文件', '关闭标签页'])
  await resetDoc(page)
})
