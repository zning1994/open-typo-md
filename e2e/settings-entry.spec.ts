/**
 * 设置的**入口位置**（用户报告：不知道这个应用有设置功能）。
 *
 * 这一组不测设置面板里有什么（那是 settings.spec.ts 的事），只测一件事：
 * **在每个平台上，用户按那个平台的习惯去找，能不能找到。**
 *
 * macOS 用户找设置只会去应用菜单，找不到就等于没有 —— 连带着「怎么换界面
 * 语言」也一起找不到，因为语言就在设置面板里。
 *
 * 用 `Menu.getApplicationMenu()` 直接读真实菜单，跟 keybindings.spec.ts 一个
 * 路子：断言的是**菜单上真正挂着什么**，不是界面上写着什么。
 *
 * 每条用例都要 `page` 这个 fixture，哪怕一次都没用到它：菜单是在窗口起来
 * 之后才建的，只取 `app` 的话会读到一份还没建好的空菜单（第一版就是这么
 * 翻的，而且只翻前两条 —— 典型的竞态长相）。
 *
 * **「放在应用菜单里」那一条只有 macOS CI 咬得到。** Linux / Windows 上它走的
 * 是「视图」那条分支，而那条分支改动前就是对的 —— 也就是说本地怎么跑都是绿的。
 * 别因此以为它没用：真正会退化的是 mac 那一半（比如有人图省事把 `isMac` 分支
 * 删掉统一放进「视图」），而那正是用户报回来的那个缺陷。
 * 这跟 `fs-mutate.test.ts` 里的纯大小写改名是同一类用例。
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { expect, test } from './fixtures.js'
import type { ElectronApplication } from '@playwright/test'

/** 菜单里所有 `设置…` 出现的位置，形如 `['Mosu', '设置…']`。 */
async function settingsPaths(app: ElectronApplication): Promise<string[][]> {
  return app.evaluate(({ Menu }) => {
    const found: string[][] = []
    const walk = (
      items: readonly { label: string; submenu?: { items: unknown[] } }[],
      trail: string[],
    ): void => {
      for (const item of items) {
        const here = [...trail, item.label]
        if (item.label === '设置…') found.push(here)
        const sub = item.submenu as { items: typeof items } | undefined
        if (sub) walk(sub.items, here)
      }
    }
    walk((Menu.getApplicationMenu()?.items ?? []) as never, [])
    return found
  })
}

test('设置在菜单里恰好出现一次 —— 出现两次用户会以为是两件事', async ({ app, page }) => {
  expect(await settingsPaths(app)).toHaveLength(1)
})

test('macOS 放在应用菜单里，其它平台放在「视图」里', async ({ app, page }) => {
  const [path] = await settingsPaths(app)
  expect(path).toBeTruthy()

  const platform = await app.evaluate(() => process.platform)
  if (platform === 'darwin') {
    // 应用菜单的标签是 app.name，不写死
    const appName = await app.evaluate(({ app: electronApp }) => electronApp.name)
    expect(path![0]).toBe(appName)
  } else {
    expect(path![0]).toBe('视图')
  }
})

test('设置项带着 ⌘, —— 那是所有平台上找设置的第二条路', async ({ app, page }) => {
  const accelerator = await app.evaluate(({ Menu }) => {
    const walk = (
      items: readonly { label: string; accelerator?: string; submenu?: { items: unknown[] } }[],
    ): string | null => {
      for (const item of items) {
        if (item.label === '设置…') return item.accelerator ?? null
        const sub = item.submenu as { items: typeof items } | undefined
        const deep = sub ? walk(sub.items) : null
        if (deep) return deep
      }
      return null
    }
    return walk((Menu.getApplicationMenu()?.items ?? []) as never)
  })
  expect(accelerator).toBe('CmdOrCtrl+,')
})
