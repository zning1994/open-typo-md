/**
 * 界面语言（docs/design/07 §4）。
 *
 * 文案表的完整性由**类型**保证（少一条就编译不过），ICU 的渲染由 21 条单测
 * 保证。这里验的是单测和类型都够不着的那部分：换一次语言之后，界面上真的
 * **没有一块留在旧语言里** —— 尤其是那些只在构造时写过一次的文案。
 *
 * 那正是 i18n 最常见的 bug 形态：不是「没翻译」，是「翻了一半」。
 */
import { ACTIVE_CONTENT, ACTIVE_PAGE, clickMenu, expect, resetDoc, test } from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

/** 打开设置面板。语言只能在这里换，所以每条用例都要走一遍。 */
async function openSettings(app: ElectronApplication, page: Page): Promise<void> {
  await clickMenu(app, ['视图', '设置…'])
  await expect(page.locator('.typo-settings')).toBeVisible()
}

/** 设置面板里某一行的控件。 */
function control(page: Page, label: string) {
  return page
    .locator('.typo-settings__row')
    .filter({ hasText: label })
    .locator('.typo-settings__control')
}

/** 顶层菜单的标签，按顺序。 */
async function menuLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label),
  )
}

/**
 * 语言下拉框，**不靠标签定位**。
 *
 * 用行标签找的话，切成英文之后就再也找不到它了（那一行现在写着 Interface
 * language）—— 而「切过去再切回来」正是每条用例收尾要做的事。
 * `option[value="ja"]` 跟界面语言无关，是这个控件唯一稳定的标志。
 */
function languageSelect(page: Page) {
  return page
    .locator('.typo-settings__row select')
    .filter({ has: page.locator('option[value="ja"]') })
}

async function switchTo(page: Page, language: string): Promise<void> {
  await languageSelect(page).selectOption(language)
}

test('换成英文之后，面板、状态栏、原生菜单一起变', async ({ app, page }) => {
  await resetDoc(page, '一段正文')
  await openSettings(app, page)

  // 前提：现在是中文。不确认这一步的话，「变成英文」可能只是它本来就是英文
  await expect(page.locator('.typo-settings__title')).toHaveText('设置')
  expect(await menuLabels(app)).toContain('视图')

  await switchTo(page, 'en')

  // 1. 面板自己重画了 —— 用户就在这个面板里操作，标题变了内容没变会让人以为没生效
  await expect(page.locator('.typo-settings__title')).toHaveText('Settings')
  await expect(page.locator('.typo-settings__row').filter({ hasText: 'Theme' })).toBeVisible()

  // 2. 原生菜单跟着重建。这条最容易漏：菜单在 main 进程，跟面板隔着一次 IPC
  await expect.poll(() => menuLabels(app)).toContain('View')
  expect(await menuLabels(app)).not.toContain('视图')

  // 3. 状态栏 —— 它只在编辑器状态变化时才刷新，换语言时必须显式重放一次
  await expect(page.locator('#status-mode')).toHaveText('Live preview')
  await expect(page.locator('#status-focus')).toHaveText('Focus')

  // 4. `<html lang>` 也要跟上，读屏软件靠它选发音
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')

  await switchTo(page, 'zh-CN')
  await page.keyboard.press('Escape')
})

test('语言列表用各语言自己的名字，且「跟随系统」排在最前', async ({ app, page }) => {
  await openSettings(app, page)
  const options = await languageSelect(page).locator('option').allTextContents()
  // 看不懂当前界面语言的人正是最需要找到这一行的人：「日本語」他认得，「Japanese」未必
  expect(options).toEqual(['跟随系统', '简体中文', 'English', '日本語'])
  await page.keyboard.press('Escape')
})

test('日文界面下编辑区里的文案也跟着变', async ({ app, page }) => {
  // 编辑区在 @typo/editor 里，它不认识我们的文案表（原则 P3），文案是注入的 ——
  // 这条正是验那条注入通路真的接上了
  await resetDoc(page, '')
  await openSettings(app, page)
  await switchTo(page, 'ja')
  await page.keyboard.press('Escape')

  await expect(page.locator(ACTIVE_CONTENT)).toHaveAttribute('aria-label', 'Markdown エディタ')

  // 光标必须离开任务那一行：光标在行上时标记会显形，复选框 widget 根本不渲染
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.type('本文')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- [ ] やること')
  await page.keyboard.press('ControlOrMeta+Home')
  await expect(page.locator(`${ACTIVE_PAGE} .cm-typo-task`)).toHaveAttribute(
    'aria-label',
    '未完了',
  )

  await resetDoc(page)
  await clickMenu(app, ['表示', '設定…'])
  await switchTo(page, 'zh-CN')
  await page.keyboard.press('Escape')
})

test('语言存进 settings.json，重开设置面板时还在', async ({ app, page }) => {
  await openSettings(app, page)
  await switchTo(page, 'en')
  await page.keyboard.press('Escape')

  await clickMenu(app, ['View', 'Settings…'])
  await expect(control(page, 'Interface language')).toHaveValue('en')

  await switchTo(page, 'zh-CN')
  await page.keyboard.press('Escape')
})
