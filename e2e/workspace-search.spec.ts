/**
 * 全工作区搜索（issue #39）。
 *
 * 断言落在**用户看得见的三件事**上：命中在哪个文件、哪一行、点了能不能跳到
 * 准确位置。匹配算法本身由 `apps/desktop/test/workspace-scan.test.ts` 单测
 * （转义、整词、零宽、跨行 lastIndex 那些坑都在那里）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ACTIVE_CONTENT, clickMenu, expect, stubOpenDialog, test } from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mosu-search-'))
  await writeFile(
    path.join(dir, '甲.md'),
    '第一行\n这里提到了目标词。\n第三行\n又一次目标词。\n',
    'utf8',
  )
  await mkdir(path.join(dir, '子'))
  await writeFile(path.join(dir, '子', '乙.md'), '子目录里也有目标词。\n', 'utf8')
  await writeFile(path.join(dir, '丙.md'), '这一份完全无关。\n', 'utf8')
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

async function openFolder(app: ElectronApplication, page: Page): Promise<void> {
  await stubOpenDialog(app, [dir])
  await clickMenu(app, ['文件', '打开文件夹…'])
  await expect(page.locator('.mosu-files')).toBeVisible()
}

const panel = (page: Page) => page.locator('.mosu-search')
const hits = (page: Page) => page.locator('.mosu-search__hit')
const files = (page: Page) => page.locator('.mosu-search__filename')

async function search(app: ElectronApplication, page: Page, query: string): Promise<void> {
  await clickMenu(app, ['编辑', '在工作区中查找…'])
  await expect(panel(page)).toBeVisible()
  await page.locator('.mosu-search__input').fill(query)
  await page.keyboard.press('Enter')
}

test('跨文件搜索，结果按文件分组并带行号', async ({ app, page }) => {
  await openFolder(app, page)
  await search(app, page, '目标词')

  // 甲.md 两处 + 子/乙.md 一处
  await expect(hits(page)).toHaveCount(3)
  await expect(files(page)).toHaveCount(2)

  const paths = await files(page).allTextContents()
  expect(new Set(paths)).toEqual(new Set(['甲.md', '子/乙.md']))

  // 行号是 1 起算，跟状态栏一致
  const lines = await page.locator('.mosu-search__line').allTextContents()
  expect(lines).toContain('2')
  expect(lines).toContain('4')
})

test('无关的文件不出现在结果里', async ({ app, page }) => {
  await openFolder(app, page)
  await search(app, page, '目标词')

  expect((await files(page).allTextContents()).join('|')).not.toContain('丙.md')
})

test('点一条结果就打开那个文件，并跳到那一处', async ({ app, page }) => {
  await openFolder(app, page)
  await search(app, page, '目标词')

  // 点第二处命中（甲.md 第 4 行）
  await hits(page).nth(1).click()
  await page.waitForTimeout(600)

  // 光标真的落在第 4 行 —— 只打开文件不跳位置的话这里会是第 1 行
  await expect(page.locator('#status-stats')).toContainText('4')
  // 打开的确实是那份文档
  await expect(page.locator('#status-name')).toContainText('甲.md')
})

test('搜完之后给出汇总；搜不到时明确说没找到', async ({ app, page }) => {
  await openFolder(app, page)
  await search(app, page, '目标词')
  await expect(page.locator('.mosu-search__status')).toContainText('2 个文件')

  await page.locator('.mosu-search__input').fill('这个词一定搜不到')
  await page.keyboard.press('Enter')
  // 「没搜到」必须说出来，空列表配一句「搜索中」会让人一直等下去
  await expect(page.locator('.mosu-search__status')).toContainText('没有找到匹配')
})

test('区分大小写的开关真的起作用', async ({ app, page }) => {
  await writeFile(path.join(dir, '英文.md'), 'Target here\ntarget there\n', 'utf8')
  await openFolder(app, page)
  await search(app, page, 'target')
  await expect(hits(page)).toHaveCount(2)

  await page.locator('.mosu-search__toggle[aria-label="区分大小写"]').click()
  await page.waitForTimeout(600)
  await expect(hits(page)).toHaveCount(1)
})

test('正则模式：写坏了不报错也不清空界面', async ({ app, page }) => {
  await openFolder(app, page)
  await search(app, page, '目标词')
  await expect(hits(page)).toHaveCount(3)

  await page.locator('.mosu-search__toggle[aria-label="正则表达式"]').click()
  await page.locator('.mosu-search__input').fill('(没闭合')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)

  // 边敲边搜时每一个中间状态都是非法的正则。不能抛，也不能一直停在「搜索中」
  await expect(panel(page)).toBeVisible()
  await expect(page.locator('.mosu-search__status')).not.toContainText('搜索中')
})

test('没打开工作区时把原因说出来', async ({ app, page }) => {
  await clickMenu(app, ['编辑', '在工作区中查找…'])
  await expect(panel(page)).toBeVisible()
  // 空着一个搜不出东西的框，用户会以为是坏了
  await expect(page.locator('.mosu-search__status')).toContainText('先打开一个文件夹')
})

test('关掉面板，焦点回到编辑器', async ({ app, page }) => {
  await openFolder(app, page)
  await search(app, page, '目标词')
  await page.locator('.mosu-search__close').click()

  await expect(panel(page)).toBeHidden()
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.type('还能打字')
  await expect(page.locator(ACTIVE_CONTENT)).toContainText('还能打字')
})
