/**
 * 快捷键编辑（docs/design/05 三 §5）。
 *
 * 翻译规则有 20 条单测。这里验的是**改了之后真的算数**，而「算数」的判据
 * 不是界面上显示成什么 —— 是**原生菜单上那个加速键真的换了**。
 *
 * 这一条不能省：真正拦住按键的是菜单（Electron 的菜单加速键优先于网页），
 * 界面显示新的、菜单还挂着旧的，是这个功能最可能的坏法。
 */
import { clickMenu, expect, openSettings as openSettingsMenu, test } from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

/** 从真实的原生菜单里读一个菜单项的加速键。 */
async function acceleratorOf(app: ElectronApplication, path: string[]): Promise<string | null> {
  return app.evaluate(({ Menu }, labels) => {
    let items = Menu.getApplicationMenu()?.items ?? []
    let target: (typeof items)[number] | undefined
    for (const label of labels) {
      target = items.find((item) => item.label === label)
      if (!target) return null
      items = target.submenu?.items ?? []
    }
    return target?.accelerator ?? null
  }, path)
}

async function openSettings(app: ElectronApplication, page: Page): Promise<void> {
  // 菜单位置按平台不同（mac 在应用菜单，其它在「视图」），
  // 所以走 fixtures 里那份共享的 —— 写死一条路径只会让另一个平台的 CI 红
  await openSettingsMenu(app)
  await expect(page.locator('.mosu-settings')).toBeVisible()
}

/** 快捷键表里某一条命令的那个录制按钮。 */
function bindingButton(page: Page, title: string) {
  return page
    .locator('.mosu-keys__row')
    .filter({ hasText: title })
    .locator('.mosu-keys__binding')
}

test.afterEach(async ({ app, page }) => {
  // 快捷键写进的是 settings.json，会活到下一条用例里 —— 必须收拾干净
  if (await page.locator('.mosu-settings').isHidden()) await openSettings(app, page)
  await page.locator('.mosu-keys__reset').click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.mosu-settings')).toBeHidden()
})

test('渲染进程读到的平台信息是真的', async ({ app, page }) => {
  // 这条在 Linux 上恒绿 —— 它守的是**另外两个平台**。
  //
  // 原来 preload 是先暴露一个默认值 `'linux'`、再异步把真值写回去；而
  // contextBridge 是按值拷贝的，那次写回根本传不过去。Linux 上「默认值恰好是
  // 对的」，于是它一直躲着，直到 macOS 的快捷键录制把 ⌘ 认成了 Ctrl。
  const real = await app.evaluate(() => process.platform)
  const expected = real === 'darwin' ? 'mac' : real === 'win32' ? 'win' : 'linux'
  expect(await page.evaluate(() => window.mosu.platform.os)).toBe(expected)
})

test('录下一个新组合，原生菜单上的加速键当场就变了', async ({ app, page }) => {
  expect(await acceleratorOf(app, ['格式', '加粗'])).toBe('CmdOrCtrl+B')

  await openSettings(app, page)
  await bindingButton(page, '加粗').click()
  // 录制中所有按键都被吞掉，所以这里按 ⌘⇧B 不会真的把什么加粗了
  await page.keyboard.press('ControlOrMeta+Shift+B')

  await expect.poll(() => acceleratorOf(app, ['格式', '加粗'])).toBe('CmdOrCtrl+Shift+B')
})

test('清空绑定之后菜单项就没有加速键了', async ({ app, page }) => {
  await openSettings(app, page)
  await page
    .locator('.mosu-keys__row')
    .filter({ hasText: '斜体' })
    .locator('.mosu-keys__clear')
    .click()

  await expect.poll(() => acceleratorOf(app, ['格式', '斜体'])).toBeNull()
  await expect(bindingButton(page, '斜体')).toHaveText('未设置')
})

test('恢复默认把菜单也一起收回去', async ({ app, page }) => {
  await openSettings(app, page)
  await bindingButton(page, '行内代码').click()
  await page.keyboard.press('ControlOrMeta+Shift+J')
  await expect.poll(() => acceleratorOf(app, ['格式', '行内代码'])).toBe('CmdOrCtrl+Shift+J')

  await page.locator('.mosu-keys__reset').click()
  await expect.poll(() => acceleratorOf(app, ['格式', '行内代码'])).toBe('CmdOrCtrl+E')
})

test('撞车了会标出来，但不拦着用户', async ({ app, page }) => {
  await openSettings(app, page)
  // 把「斜体」也绑到 ⌘B 上，跟「加粗」撞车
  await bindingButton(page, '斜体').click()
  await page.keyboard.press('ControlOrMeta+B')

  const row = page.locator('.mosu-keys__row').filter({ hasText: '斜体' })
  await expect(row.locator('.mosu-keys__conflict')).toBeVisible()
  // 标归标，绑定还是照样写进去了 —— 我们判断不了用户的上下文
  await expect.poll(() => acceleratorOf(app, ['格式', '斜体'])).toBe('CmdOrCtrl+B')
})

test('命令面板里显示的是改过之后的绑定，不是出厂那份', async ({ app, page }) => {
  await openSettings(app, page)
  await bindingButton(page, '大纲').click()
  await page.keyboard.press('ControlOrMeta+Shift+G')
  await page.keyboard.press('Escape')
  await expect(page.locator('.mosu-settings')).toBeHidden()

  await clickMenu(app, ['视图', '命令面板'])
  await page.locator('.mosu-palette__input').fill('大纲')
  await expect(page.locator('.mosu-palette__key').first()).toHaveText(/G/)
  await page.keyboard.press('Escape')
})
