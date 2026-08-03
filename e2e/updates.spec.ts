/**
 * 检查更新（用户要求进 0.2.0）。
 *
 * 顶掉的是 **`net.fetch`**，也就是系统那一层 —— 从菜单项、到 IPC、到设置开关
 * 的拦截、到版本比较、到最后弹哪个对话框，产品代码一行都没绕开。
 * 版本比较本身的边界在 `apps/desktop/test/updates.test.ts` 里单测。
 *
 * 三条边界（见 main/updates.ts）里的头一条 —— **只在用户按下时才发** ——
 * 也在这里钉住：启动之后什么都不做的话，一个请求都不该发出去。
 */
import { expect, openCheckUpdates, test } from './fixtures.js'
import type { ElectronApplication } from '@playwright/test'

/** 顶掉 `net.fetch`，记下它被调过几次，并按需要给一个假响应。 */
async function stubFetch(
  app: ElectronApplication,
  reply: { status: number; body?: unknown } | 'reject',
): Promise<void> {
  await app.evaluate(({ net }, payload) => {
    const store = globalThis as unknown as { __fetches: string[] }
    store.__fetches = []
    ;(net as unknown as { fetch: unknown }).fetch = async (url: string) => {
      store.__fetches.push(url)
      if (payload === 'reject') throw new Error('offline')
      return {
        ok: payload.status >= 200 && payload.status < 300,
        status: payload.status,
        json: async () => payload.body,
      }
    }
  }, reply)
}

async function fetchCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    () => ((globalThis as unknown as { __fetches?: string[] }).__fetches ?? []).length,
  )
}

/** 顶掉对话框，记下它显示了什么。菜单命令是异步投递的，所以取的时候要等。 */
async function stubDialogs(app: ElectronApplication, buttonIndex = 1): Promise<void> {
  await app.evaluate(({ dialog }, index) => {
    const store = globalThis as unknown as { __dialogs: { message: string; detail: string }[] }
    store.__dialogs = []
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as {
        message?: string
        detail?: string
      }
      store.__dialogs.push({ message: options.message ?? '', detail: options.detail ?? '' })
      return { response: index, checkboxChecked: false }
    }
  }, buttonIndex)
}

async function lastDialog(
  app: ElectronApplication,
): Promise<{ message: string; detail: string }> {
  return expect
    .poll(
      () =>
        app.evaluate(() => {
          const store = globalThis as unknown as { __dialogs?: { message: string }[] }
          return store.__dialogs?.[store.__dialogs.length - 1] ?? null
        }),
      { timeout: 8_000 },
    )
    .not.toBeNull()
    .then(() =>
      app.evaluate(() => {
        const store = globalThis as unknown as {
          __dialogs: { message: string; detail: string }[]
        }
        return store.__dialogs[store.__dialogs.length - 1]!
      }),
    )
}

test('启动之后一个请求都不发 —— 只有用户按下去才联网', async ({ app, page }) => {
  await stubFetch(app, { status: 200, body: { tag_name: 'v9.9.9' } })
  await page.waitForTimeout(1_500)
  expect(await fetchCount(app)).toBe(0)
})

test('有新版本时给出版本号，并能去下载页', async ({ app, page }) => {
  await stubFetch(app, {
    status: 200,
    body: { tag_name: 'v9.9.9', html_url: 'https://example.com/release' },
  })
  await stubDialogs(app)
  await openCheckUpdates(app)

  const shown = await lastDialog(app)
  expect(shown.message).toContain('9.9.9')
  expect(await fetchCount(app)).toBe(1)
  await page.waitForTimeout(100)
})

test('线上版本更旧时说「已经是最新」，不谎报有更新', async ({ app, page }) => {
  await stubFetch(app, { status: 200, body: { tag_name: 'v0.0.1' } })
  await stubDialogs(app)
  await openCheckUpdates(app)

  expect((await lastDialog(app)).message).toContain('已经是最新版本')
  await page.waitForTimeout(100)
})

test('连不上时明确说没检查成 —— 绝不显示成「已是最新」', async ({ app, page }) => {
  // 把失败显示成「已是最新版本」是在骗用户：他会以为自己装的是最新的
  await stubFetch(app, 'reject')
  await stubDialogs(app)
  await openCheckUpdates(app)

  const shown = await lastDialog(app)
  expect(shown.message).toContain('没能检查更新')
  expect(shown.message).not.toContain('已经是最新')
  await page.waitForTimeout(100)
})

test('被限流时说得出是限流，而不是笼统的「网络错误」', async ({ app, page }) => {
  await stubFetch(app, { status: 403 })
  await stubDialogs(app)
  await openCheckUpdates(app)

  expect((await lastDialog(app)).detail).toContain('限制了请求')
  await page.waitForTimeout(100)
})

test('还没有已发布版本（只有草稿）时说清楚', async ({ app, page }) => {
  // 发布流程建的是草稿 Release，而 `/releases/latest` 按定义排除草稿
  await stubFetch(app, { status: 404 })
  await stubDialogs(app)
  await openCheckUpdates(app)

  expect((await lastDialog(app)).detail).toContain('还没有已发布的版本')
  await page.waitForTimeout(100)
})

test('设置里关掉之后，main 直接拒绝 —— 一个包都不发出去', async ({ app, page }) => {
  await page.evaluate(() => window.mosu.settings.set('updates.check', false))
  await stubFetch(app, { status: 200, body: { tag_name: 'v9.9.9' } })
  await stubDialogs(app)
  await openCheckUpdates(app)

  expect((await lastDialog(app)).detail).toContain('已在设置里关闭')
  // 关键的一句：拦截发生在**发请求之前**
  expect(await fetchCount(app)).toBe(0)
})
