/**
 * Quick Open（issue #37）。
 *
 * 报告里的原话是「输入 03-mock，结果是『没有匹配的命令』」—— 命令面板和
 * 「找文件」挤在一个入口里。所以这一组的第一条就是**两个面板确实是两个东西**。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, docText, expect, stubOpenDialog, test } from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mosu-quickopen-'))
  await writeFile(path.join(dir, '03-mock.md'), '# 模拟数据\n\n正文。\n', 'utf8')
  await writeFile(path.join(dir, 'readme.md'), '# 说明\n\n正文。\n', 'utf8')
  await mkdir(path.join(dir, 'design'))
  await writeFile(path.join(dir, 'design', '架构.md'), '# 架构设计\n\n正文。\n', 'utf8')
  // 噪声：非 Markdown 与点目录都不该出现在候选里
  await writeFile(path.join(dir, '图.png'), 'x', 'utf8')
  await mkdir(path.join(dir, 'node_modules'))
  await writeFile(path.join(dir, 'node_modules', '包.md'), 'x', 'utf8')
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

async function openFolder(app: ElectronApplication, page: Page): Promise<void> {
  await stubOpenDialog(app, [dir])
  await clickMenu(app, ['文件', '打开文件夹…'])
  await expect(page.locator('.mosu-files')).toBeVisible()
}

const panel = (page: Page) => page.locator('.mosu-quickopen')
const results = (page: Page) => page.locator('.mosu-quickopen__item')

async function openQuickOpen(app: ElectronApplication, page: Page): Promise<void> {
  await clickMenu(app, ['视图', '快速打开…'])
  await expect(panel(page)).toBeVisible()
  // 工作区清单是异步取的，标题还要再晚一步
  await page.waitForTimeout(600)
}

test('输入文件名的一部分就能找到文件 —— 这正是报告里失败的那一步', async ({ app, page }) => {
  await openFolder(app, page)
  await openQuickOpen(app, page)

  await page.locator('.mosu-quickopen__input').fill('03-mock')
  await expect(results(page)).toHaveCount(1)
  await page.keyboard.press('Enter')

  await expect.poll(() => docText(page)).toContain('模拟数据')
})

test('命令面板里搜同一个词仍然找不到 —— 两个面板是两件事', async ({ app, page }) => {
  await openFolder(app, page)
  await clickMenu(app, ['视图', '命令面板'])
  await page.locator('.mosu-palette__input').fill('03-mock')

  // 命令面板只找动作。这条断言不是在描述缺陷，是在描述分工
  await expect(page.locator('.mosu-palette__empty')).toHaveCount(1)
})

test('按文档标题也能找到 —— 标题里的字文件名里一个都没有', async ({ app, page }) => {
  await openFolder(app, page)
  await openQuickOpen(app, page)

  await page.locator('.mosu-quickopen__input').fill('架构设计')
  await expect(results(page)).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect.poll(() => docText(page)).toContain('架构设计')
})

test('按相对路径也能找到', async ({ app, page }) => {
  await openFolder(app, page)
  await openQuickOpen(app, page)

  await page.locator('.mosu-quickopen__input').fill('design/')
  await expect(results(page)).toHaveCount(1)
})

test('非 Markdown 与 node_modules 不进候选', async ({ app, page }) => {
  await openFolder(app, page)
  await openQuickOpen(app, page)

  const labels = (await results(page).allTextContents()).join('|')
  expect(labels).not.toContain('图.png')
  expect(labels).not.toContain('包.md')
})

test('已打开的标签排在前面并标出来', async ({ app, page }) => {
  await openFolder(app, page)
  // 先打开 readme
  await page.locator('.mosu-files__item').filter({ hasText: '说明' }).click()
  await expect.poll(() => docText(page)).toContain('说明')

  await openQuickOpen(app, page)
  // 空查询时按「打开的在前」列出来
  await expect(results(page).first()).toContainText('已打开')
})

test('同一个文件不会既作为标签又作为工作区文件出现两次', async ({ app, page }) => {
  await openFolder(app, page)
  await page.locator('.mosu-files__item').filter({ hasText: '说明' }).click()
  await expect.poll(() => docText(page)).toContain('说明')

  await openQuickOpen(app, page)
  await page.locator('.mosu-quickopen__input').fill('readme')
  await expect(results(page)).toHaveCount(1)
})

test('Esc 关掉面板，焦点回到编辑器', async ({ app, page }) => {
  await openFolder(app, page)
  await openQuickOpen(app, page)
  await page.keyboard.press('Escape')

  await expect(panel(page)).toBeHidden()
  // 焦点没回去的话，下一次按键石沉大海
  await page.keyboard.type('还能打字')
  await expect.poll(() => docText(page)).toContain('还能打字')
})

test('没打开工作区时面板照样能开，不报错', async ({ app, page }) => {
  await clickMenu(app, ['视图', '快速打开…'])
  await expect(panel(page)).toBeVisible()
  await expect(page.locator('.mosu-quickopen__empty')).toHaveCount(1)
})
