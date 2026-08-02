/**
 * 文件树（docs/design/04 §2）。
 *
 * 它是个只读的导航视图：点一下在标签里打开，仅此而已。所以用例也只围着
 * 「列得对不对、点得开不开、噪声有没有被挡掉」转。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, docText, expect, resetDoc, stubOpenDialog, test } from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mosu-tree-'))
  await writeFile(path.join(dir, '甲.md'), '甲的内容', 'utf8')
  await writeFile(path.join(dir, '乙.md'), '乙的内容', 'utf8')
  await mkdir(path.join(dir, '子目录'))
  await writeFile(path.join(dir, '子目录', '丙.md'), '丙的内容', 'utf8')
  // 噪声：点文件与大目录都不该出现在树里
  await mkdir(path.join(dir, 'node_modules'))
  await writeFile(path.join(dir, 'node_modules', '包.md'), 'x', 'utf8')
  await writeFile(path.join(dir, '.hidden.md'), 'x', 'utf8')
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

async function openFolder(app: ElectronApplication, page: Page): Promise<void> {
  await stubOpenDialog(app, [dir])
  await clickMenu(app, ['文件', '打开文件夹…'])
  await expect(page.locator('.mosu-files')).toBeVisible()
}

const items = (page: Page) => page.locator('.mosu-files__item')

test('打开文件夹后列出内容，目录在前', async ({ app, page }) => {
  await openFolder(app, page)

  await expect(items(page)).toHaveCount(3)
  await expect(items(page).first()).toHaveText('▸子目录')
  await expect(page.locator('.mosu-files__title')).toHaveText(path.basename(dir))
})

test('点文件与 node_modules 不进树 —— 前者是工具的东西，后者是量级问题', async ({
  app,
  page,
}) => {
  await openFolder(app, page)

  const names = await items(page).allTextContents()
  expect(names.join('|')).not.toContain('node_modules')
  expect(names.join('|')).not.toContain('.hidden')
})

test('点一下在标签里打开', async ({ app, page }) => {
  await openFolder(app, page)
  await items(page).filter({ hasText: '甲.md' }).click()

  await expect.poll(() => docText(page)).toBe('甲的内容')
  // 打开的文件在树里高亮
  await expect(items(page).filter({ hasText: '甲.md' })).toHaveClass(/is-active/)
})

test('子目录懒展开', async ({ app, page }) => {
  await openFolder(app, page)
  // 展开之前，子目录里的文件不在 DOM 里 —— 一次性递归整棵树在大仓库上要几秒
  await expect(items(page).filter({ hasText: '丙.md' })).toHaveCount(0)

  await items(page).filter({ hasText: '子目录' }).click()
  await expect(items(page).filter({ hasText: '丙.md' })).toHaveCount(1)

  await items(page).filter({ hasText: '丙.md' }).click()
  await expect.poll(() => docText(page)).toBe('丙的内容')
})

test('刷新能看见新加的文件（目录不监听，所以给了刷新）', async ({ app, page }) => {
  await openFolder(app, page)
  await writeFile(path.join(dir, '丁.md'), '丁的内容', 'utf8')

  await expect(items(page).filter({ hasText: '丁.md' })).toHaveCount(0)
  await page.locator('.mosu-files__refresh').click()
  await expect(items(page).filter({ hasText: '丁.md' })).toHaveCount(1)
})

test('关闭文件夹，树收起来', async ({ app, page }) => {
  await openFolder(app, page)
  await clickMenu(app, ['文件', '关闭文件夹'])
  await expect(page.locator('.mosu-files')).toBeHidden()

  await resetDoc(page)
})
