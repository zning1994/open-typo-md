/**
 * 右键菜单与「保存全部」（issues #17 / #18 / #19）。
 *
 * ## 原生菜单弹出来之后是测不了的
 *
 * `Menu.popup()` 是系统菜单，Playwright 够不着，而且它会阻塞直到用户选中。
 * 所以这里把**弹出那一步**替身掉：记下渲染进程发过去的请求，直接返回一个
 * 选择。这样测到的正是会写错的那部分 —— 右键的是哪个标签、上下文标志算得
 * 对不对、拿到某个选择之后做了什么。
 *
 * 剩下没被覆盖的只有「Electron 真的弹了一个菜单」，那是 Electron 的职责；
 * 菜单里有哪几项、哪些灰掉，由 `apps/desktop/test/context-menu.test.ts`
 * 直接对模板断言。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ACTIVE_CONTENT, clickMenu, expect, resetDoc, test } from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mosu-ctx-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

/**
 * 顶掉**原生菜单的弹出**，并记下它真正长什么样。
 *
 * 顶的是 Electron 的 `Menu.prototype.popup` —— 跟这套用例里 `stubOpenDialog`
 * 顶掉原生保存对话框是同一个姿势：替身的是系统那一层，产品代码从渲染进程
 * 一直到 main 的模板构建一行都没绕开。
 *
 * 第一版试过在页面里改 `window.mosu.menu.context`，**行不通** ——
 * contextBridge 暴露出去的对象是只读的（那正是它的安全性所在），
 * 赋值静默失败，于是替身根本没被调用过。
 *
 * 记下 `menu.items` 而不是请求本身：菜单的形状是请求的函数，
 * 断言它等于把「渲染进程算的上下文 → main 建的模板」整条链一起验了。
 */
async function stubPopup(app: ElectronApplication, pick: string | null): Promise<void> {
  await app.evaluate(({ Menu }, label) => {
    const store = globalThis as unknown as { __menus: unknown[] }
    store.__menus = []
    ;(Menu.prototype as unknown as { popup: (options?: unknown) => void }).popup = function (
      this: { items: { label: string; enabled: boolean; role?: string; click?: () => void }[] },
      options?: { callback?: () => void },
    ) {
      store.__menus.push(
        this.items.map((item) => ({
          label: item.label,
          enabled: item.enabled,
          role: item.role ?? null,
        })),
      )
      if (label) this.items.find((item) => item.label === label)?.click?.()
      options?.callback?.()
    }
  }, pick)
}

/** 最后一次弹出的菜单形状。 */
async function lastMenu(
  app: ElectronApplication,
): Promise<{ label: string; enabled: boolean; role: string | null }[]> {
  return app.evaluate(() => {
    const store = globalThis as unknown as {
      __menus: { label: string; enabled: boolean; role: string | null }[][]
    }
    return store.__menus[store.__menus.length - 1] ?? []
  })
}

/** 某一项现在可不可点。找不到就抛 —— 静默返回 false 会把「项没了」说成「灰了」。 */
function enabledOf(menu: { label: string; enabled: boolean }[], label: string): boolean {
  const item = menu.find((entry) => entry.label === label)
  if (!item)
    throw new Error(`菜单里找不到「${label}」，实际有：${menu.map((e) => e.label).join(' / ')}`)
  return item.enabled
}

async function rightClick(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().click({ button: 'right' })
  await page.waitForTimeout(200)
}

test.describe('编辑区右键菜单', () => {
  test('有选区时剪切 / 复制 / 查找选中都可点', async ({ app, page }) => {
    await resetDoc(page, '一段可以选的文字')
    await stubPopup(app, null)

    await page.locator(ACTIVE_CONTENT).click()
    await page.keyboard.press('ControlOrMeta+a')
    await rightClick(page, ACTIVE_CONTENT)

    const menu = await lastMenu(app)
    expect(enabledOf(menu, '剪切')).toBe(true)
    expect(enabledOf(menu, '复制')).toBe(true)
    expect(enabledOf(menu, '查找选中内容')).toBe(true)
  })

  test('没选区时那三项灰掉，粘贴照旧可点', async ({ app, page }) => {
    await resetDoc(page, '一段文字')
    await stubPopup(app, null)

    await page.locator(ACTIVE_CONTENT).click()
    await rightClick(page, ACTIVE_CONTENT)

    const menu = await lastMenu(app)
    expect(enabledOf(menu, '剪切')).toBe(false)
    expect(enabledOf(menu, '复制')).toBe(false)
    expect(enabledOf(menu, '查找选中内容')).toBe(false)
    expect(enabledOf(menu, '粘贴')).toBe(true)
  })

  test('剪切 / 复制 / 粘贴走系统 role，不是我们自己实现的', async ({ app, page }) => {
    await resetDoc(page, '正文')
    await stubPopup(app, null)
    await page.locator(ACTIVE_CONTENT).click()
    await rightClick(page, ACTIVE_CONTENT)

    const menu = await lastMenu(app)
    expect(menu.find((item) => item.label === '剪切')?.role).toBe('cut')
    expect(menu.find((item) => item.label === '粘贴')?.role).toBe('paste')
    // 查找选中是我们自己的，没有 role
    expect(menu.find((item) => item.label === '查找选中内容')?.role).toBeNull()
  })

  test('选「查找选中内容」会打开查找面板', async ({ app, page }) => {
    await resetDoc(page, '一段可以选的文字')
    await stubPopup(app, '查找选中内容')

    await page.locator(ACTIVE_CONTENT).click()
    await page.keyboard.press('ControlOrMeta+a')
    await rightClick(page, ACTIVE_CONTENT)

    await expect(page.locator('.cm-search')).toHaveCount(1)
    await page.keyboard.press('Escape')
  })

  test('右键不会弹出浏览器自带的菜单', async ({ app, page }) => {
    // 没有 preventDefault 的话 Chromium 会弹它自己那个（含「检查元素」），
    // 那在一个打包应用里是不该出现的东西
    await resetDoc(page, '正文')
    await stubPopup(app, null)
    const defaultPrevented = await page.evaluate(() => {
      const target = document.querySelector('.tab-page:not([hidden]) .cm-content')!
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(defaultPrevented).toBe(true)
  })
})

test.describe('标签右键菜单', () => {
  /** 开出 n 个标签（第一个是启动就有的那个）。 */
  async function openTabs(page: Page, app: Parameters<typeof clickMenu>[0], n: number) {
    for (let i = 1; i < n; i++) await clickMenu(app, ['文件', '新建标签页'])
    await expect(page.locator('#tab-bar [data-tab]')).toHaveCount(n)
  }

  test('右键中间的标签：关闭其他 / 关闭右侧都可点', async ({ app, page }) => {
    await openTabs(page, app, 3)
    await stubPopup(app, null)

    await page.locator('#tab-bar [data-tab]').nth(1).click({ button: 'right' })
    await page.waitForTimeout(200)

    const menu = await lastMenu(app)
    expect(enabledOf(menu, '关闭其他标签页')).toBe(true)
    expect(enabledOf(menu, '关闭右侧标签页')).toBe(true)
    // 都是未命名文档，没有路径可复制
    expect(enabledOf(menu, '复制文件路径')).toBe(false)

    for (let i = 0; i < 2; i++) await clickMenu(app, ['文件', '关闭标签页'])
  })

  test('最右边那个标签「关闭右侧」是灰的', async ({ app, page }) => {
    await openTabs(page, app, 2)
    await stubPopup(app, null)

    await page.locator('#tab-bar [data-tab]').last().click({ button: 'right' })
    await page.waitForTimeout(200)

    const menu = await lastMenu(app)
    expect(enabledOf(menu, '关闭其他标签页')).toBe(true)
    expect(enabledOf(menu, '关闭右侧标签页')).toBe(false)

    await clickMenu(app, ['文件', '关闭标签页'])
  })

  test('已保存的文档才有「复制文件路径」可点', async ({ app, page }) => {
    const target = path.join(dir, '甲.md')
    await writeFile(target, '内容\n', 'utf8')
    await clickMenu(app, ['文件', '新建标签页'])
    await app.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
      },
      [target],
    )
    await clickMenu(app, ['文件', '打开…'])
    await expect.poll(() => page.locator('#status-name').textContent()).toContain('甲')

    await stubPopup(app, null)
    await page.locator('#tab-bar [data-tab]').last().click({ button: 'right' })
    await page.waitForTimeout(200)

    const menu = await lastMenu(app)
    expect(enabledOf(menu, '复制文件路径')).toBe(true)
    expect(enabledOf(menu, '在文件夹中显示')).toBe(true)

    await clickMenu(app, ['文件', '关闭标签页'])
  })

  test('选「关闭其他标签页」只留下被右键的那个', async ({ app, page }) => {
    await openTabs(page, app, 3)
    await stubPopup(app, '关闭其他标签页')

    await page.locator('#tab-bar [data-tab]').nth(1).click({ button: 'right' })

    await expect.poll(() => page.locator('#tab-bar [data-tab]').count()).toBe(1)
  })

  test('选「关闭右侧标签页」只关右边的，左边的留着', async ({ app, page }) => {
    await openTabs(page, app, 3)
    await stubPopup(app, '关闭右侧标签页')

    await page.locator('#tab-bar [data-tab]').nth(1).click({ button: 'right' })

    await expect.poll(() => page.locator('#tab-bar [data-tab]').count()).toBe(2)

    await clickMenu(app, ['文件', '关闭标签页'])
  })
})

test.describe('保存全部', () => {
  test('两个标签都存下去，脏标记一起消失', async ({ app, page }) => {
    const a = path.join(dir, 'a.md')
    const b = path.join(dir, 'b.md')
    await writeFile(a, '旧的 A\n', 'utf8')
    await writeFile(b, '旧的 B\n', 'utf8')

    for (const target of [a, b]) {
      await clickMenu(app, ['文件', '新建标签页'])
      await app.evaluate(
        ({ dialog }, paths) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
        },
        [target],
      )
      await clickMenu(app, ['文件', '打开…'])
      await expect
        .poll(() => page.locator('#status-name').textContent())
        .toContain(path.basename(target))
    }
    // [未命名, a.md, b.md]
    await expect(page.locator('#tab-bar [data-tab]')).toHaveCount(3)

    // 两篇都改脏。**每一步都等状态栏跟上**：不等的话
    // `ACTIVE_CONTENT` 可能还指着切换前那个标签，两次编辑落进同一篇 ——
    // 第一版就是这么挂的，而且挂得很误导（另一篇「没保存」，看着像功能坏了）
    for (const name of ['a.md', 'b.md']) {
      await page.locator('#tab-bar [data-tab]').filter({ hasText: name }).click()
      await expect.poll(() => page.locator('#status-name').textContent()).toContain(name)
      await page.locator(ACTIVE_CONTENT).click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type('改过了')
      await expect(page.locator('#status-name')).toContainText(`● ${name}`)
    }
    await expect(page.locator('#tab-bar .is-dirty')).toHaveCount(2)

    await clickMenu(app, ['文件', '保存全部'])

    await expect.poll(() => readFile(a, 'utf8')).toContain('改过了')
    await expect.poll(() => readFile(b, 'utf8')).toContain('改过了')
    // 标签条上一个未保存标记都不该剩
    await expect.poll(() => page.locator('#tab-bar .is-dirty').count()).toBe(0)

    for (let i = 0; i < 2; i++) await clickMenu(app, ['文件', '关闭标签页'])
  })

  test('没有可保存的东西时给个回执，而不是静默无反应', async ({ app, page }) => {
    await resetDoc(page, '')
    // 对话框会挡住后续操作，先替身掉并记下它说了什么
    await app.evaluate(({ dialog }) => {
      ;(globalThis as unknown as { __msg: string[] }).__msg = []
      dialog.showMessageBox = async (_w: unknown, options: { message: string }) => {
        ;(globalThis as unknown as { __msg: string[] }).__msg.push(options.message)
        return { response: 0, checkboxChecked: false }
      }
    })

    await clickMenu(app, ['文件', '保存全部'])

    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { __msg: string[] }).__msg))
      .toEqual(['没有需要保存的修改。'])
  })
})
