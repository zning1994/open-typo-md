/**
 * 窗口内的标签页（docs/adr/0005）。
 *
 * 验的是那条主线成不成立：**状态挂在标签上**。所以用例都围着「两个标签互不
 * 串味」转 —— 内容、撤销栈、脏标记、保存目标。共用一个编辑器的实现能通过
 * 「两个标签显示不同内容」，但一定过不了撤销那条。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ACTIVE_CONTENT,
  clickMenu,
  docText,
  expect,
  resetDoc,
  stubOpenDialog,
  test,
} from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mosu-tabs-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

/** 造一个文件并通过真菜单打开它。 */
async function openFile(
  app: ElectronApplication,
  page: Page,
  name: string,
  body: string,
): Promise<string> {
  const target = path.join(dir, name)
  await writeFile(target, body, 'utf8')
  await stubOpenDialog(app, [target])
  await clickMenu(app, ['文件', '打开…'])
  await expect.poll(() => docText(page)).toContain(body.split('\n')[0]!)
  return target
}

const tabs = (page: Page) => page.locator('.tab-bar .tab')

test('第一个文件复用空白标签，第二个才开新标签', async ({ app, page }) => {
  await openFile(app, page, 'a.md', '甲文档')
  // 空白未命名文档被就地复用 —— 为一个空标签再开一个新标签很蠢
  await expect(page.locator('.tab-bar')).toBeHidden()

  await openFile(app, page, 'b.md', '乙文档')
  await expect(tabs(page)).toHaveCount(2)
})

test('同一个文件不会开出第二个标签，直接切过去', async ({ app, page }) => {
  const first = await openFile(app, page, 'a.md', '甲文档')
  await openFile(app, page, 'b.md', '乙文档')

  await stubOpenDialog(app, [first])
  await clickMenu(app, ['文件', '打开…'])

  // 两份撤销栈和脏标记指着同一个文件，保存时必然互相覆盖 —— 那是数据丢失
  await expect(tabs(page)).toHaveCount(2)
  await expect.poll(() => docText(page)).toBe('甲文档')
})

test('切标签换的是整套状态 —— 连撤销栈也不串', async ({ app, page }) => {
  await openFile(app, page, 'a.md', '甲文档')
  await openFile(app, page, 'b.md', '乙文档')

  // 在乙里敲点东西
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('（改过）')
  expect(await docText(page)).toBe('乙文档（改过）')

  // 切到甲，按撤销 —— 撤销栈若是共用的，这里会把乙的修改倒出来
  await tabs(page).first().click()
  await expect.poll(() => docText(page)).toBe('甲文档')
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await docText(page)).toBe('甲文档')

  // 切回乙，改动还在
  await tabs(page).nth(1).click()
  await expect.poll(() => docText(page)).toBe('乙文档（改过）')
})

test('脏标记是每个标签自己的', async ({ app, page }) => {
  await openFile(app, page, 'a.md', '甲文档')
  await openFile(app, page, 'b.md', '乙文档')

  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.type('脏')

  await expect(tabs(page).nth(1)).toHaveClass(/is-dirty/)
  await expect(tabs(page).first()).not.toHaveClass(/is-dirty/)
})

test('关掉一个标签会落到另一个上', async ({ app, page }) => {
  await openFile(app, page, 'a.md', '甲文档')
  await openFile(app, page, 'b.md', '乙文档')

  await clickMenu(app, ['文件', '关闭标签页'])
  await expect(page.locator('.tab-bar')).toBeHidden()
  await expect.poll(() => docText(page)).toBe('甲文档')
})

test('关掉最后一个标签会补一个空白标签，而不是留下一个空窗口', async ({ app, page }) => {
  await openFile(app, page, 'a.md', '甲文档')
  await clickMenu(app, ['文件', '关闭标签页'])

  // 「窗口里一个文档都没有」是个没有意义的状态：
  // 状态栏、菜单、导出全都没有作用对象
  await expect(page.locator(ACTIVE_CONTENT)).toBeVisible()
  await expect.poll(() => docText(page)).toBe('')
  await expect(page.locator('#status-name')).toHaveText('未命名.md')
})

test('新建标签页', async ({ app, page }) => {
  await openFile(app, page, 'a.md', '甲文档')
  await clickMenu(app, ['文件', '新建标签页'])

  await expect(tabs(page)).toHaveCount(2)
  await expect.poll(() => docText(page)).toBe('')
})

test('多个未保存标签关窗口时只弹一次对话框，且列出全部文件', async ({ app, page }) => {
  // ADR-0005 §关键推论 4：逐个弹窗时用户在第三个框上点「取消」，
  // 前两个已经存下去了 —— 取消了个寂寞
  await openFile(app, page, 'a.md', '甲文档')
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.type('脏')
  await openFile(app, page, 'b.md', '乙文档')
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.type('脏')

  await app.evaluate(({ dialog }) => {
    const seen: { message: string; detail: string }[] = []
    dialog.showMessageBox = (async (_win: unknown, options: unknown) => {
      const o = options as { message: string; detail?: string }
      seen.push({ message: o.message, detail: o.detail ?? '' })
      return { response: 2, checkboxChecked: false } // 取消
    }) as never
    ;(globalThis as Record<string, unknown>)['__mosuDialogCalls'] = seen
  })

  // 从 main 侧关窗口 —— 那才是点窗口 X 时走的路。渲染进程里调 window.close()
  // 会被 Electron 直接执行掉，根本不经过 close 事件里的那次确认
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as Record<string, unknown>)['__mosuDialogCalls']),
    )
    .toHaveLength(1)

  const [only] = (await app.evaluate(
    () => (globalThis as Record<string, unknown>)['__mosuDialogCalls'],
  )) as { message: string; detail: string }[]
  expect(only!.message).toContain('2 个文档尚未保存')
  expect(only!.detail).toContain('a.md')
  expect(only!.detail).toContain('b.md')

  // 点了取消，窗口还在
  await expect(page.locator(ACTIVE_CONTENT)).toBeVisible()
  await resetDoc(page)
  await tabs(page).first().click()
  await resetDoc(page)
})
