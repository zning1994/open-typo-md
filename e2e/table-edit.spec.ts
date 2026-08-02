/**
 * 表格编辑（docs/design/02 §6.4）。
 *
 * 变换逻辑有 33 条单测。这里验的是**真键位与真菜单**：Tab 有没有被表格接走、
 * 有没有踩坏列表里的 Tab、菜单项接到的是不是同一批命令。
 *
 * 最要紧的是最后那条撤销用例。「表格编辑器」当初被列进硬骨头，就是因为
 * 通行做法要在 widget 里存一份第二状态，而它和撤销栈迟早会脱节 ——
 * 「编辑完表格按 ⌘Z 文档烂掉」。这里的实现一份状态都不持有，
 * 那条用例就是这个设计的验收。
 */
import { clickMenu, docText, expect, pasteText, resetDoc, test } from './fixtures.js'

const TABLE = ['| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |'].join('\n')

/** 把光标放到某个单元格的文字上。 */
async function clickCell(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('.cm-content').getByText(text, { exact: false }).first().click()
}

test('Tab 在单元格之间走，一个字都不改', async ({ page }) => {
  await pasteText(page, TABLE)
  await clickCell(page, '甲')
  await page.keyboard.press('Tab')
  // Tab 过去是选中内容，直接敲就是替换 —— 表格导航的通行语义
  await page.keyboard.type('丙')

  expect(await docText(page)).toContain('丙')
  expect(await docText(page)).not.toContain('乙')
})

test('最后一格按 Tab 长出新的一行', async ({ page }) => {
  await pasteText(page, TABLE)
  await clickCell(page, '2')
  await page.keyboard.press('Tab')

  expect((await docText(page)).split('\n')).toHaveLength(4)
})

test('回车去下一行；末行为空时回车退出表格', async ({ page }) => {
  await pasteText(page, TABLE)
  await clickCell(page, '甲')
  await page.keyboard.press('Enter')
  await page.keyboard.type('新')
  expect(await docText(page)).toContain('新')

  // 走到表尾：Tab 出一个空行，再回车就该离开表格
  await clickCell(page, '2')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await page.keyboard.type('表格外的段落')

  const text = await docText(page)
  expect(text.split('\n').at(-1)).toBe('表格外的段落')
})

test('手敲一张完整的表格 —— 回车不能替用户长行', async ({ page }) => {
  // 回车若在表尾接管，接着敲的这一行会被插进刚长出来的单元格里，
  // 得到一堆嵌套竖线。这是「表格接管按键」最容易踩坏的一件事
  await resetDoc(page)
  await page.keyboard.type('| 甲 | 乙 |')
  await page.keyboard.press('Enter')
  await page.keyboard.type('| --- | --- |')
  await page.keyboard.press('Enter')
  await page.keyboard.type('| 1 | 2 |')

  expect(await docText(page)).toBe('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |')

  // 把光标带出表格再看渲染：表格处于激活态时分隔行是显形的，那会数出三行
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-mosu-tr')).toHaveCount(2)
})

test('表格没有抢走列表里的 Tab', async ({ page }) => {
  // 表格命令排在通用 Tab 前面，接错了这条就会挂
  await resetDoc(page, '- 甲')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.type('乙')

  expect(await docText(page)).toBe('- 甲\n  - 乙')
})

test('菜单里插入表格，光标落在第一格', async ({ app, page }) => {
  await resetDoc(page)
  await clickMenu(app, ['格式', '表格', '插入表格'])
  await expect(page.locator('.cm-mosu-tr')).not.toHaveCount(0)

  await page.keyboard.type('标题')
  expect(await docText(page)).toContain('标题')
})

test('菜单里增删行列', async ({ app, page }) => {
  await pasteText(page, TABLE)
  await clickCell(page, '1')

  await clickMenu(app, ['格式', '表格', '在下方插入行'])
  await expect.poll(async () => (await docText(page)).split('\n').length).toBe(4)

  await clickCell(page, '1')
  await clickMenu(app, ['格式', '表格', '在右侧插入列'])
  await expect.poll(async () => (await docText(page)).split('\n')[0]).toContain('|     |')

  await clickCell(page, '1')
  await clickMenu(app, ['格式', '表格', '删除本行'])
  await expect.poll(async () => (await docText(page)).split('\n').length).toBe(3)
})

test('菜单里改列对齐 —— 改的只是分隔行', async ({ app, page }) => {
  await pasteText(page, TABLE)
  await clickCell(page, '1')
  await clickMenu(app, ['格式', '表格', '本列居中'])

  await expect.poll(async () => (await docText(page)).split('\n')[1]).toBe('| :-: | --- |')
})

test('整理表格按显示宽度对齐 —— 中文占两格', async ({ app, page }) => {
  await pasteText(page, '| 甲 | b |\n| --- | --- |\n| 一二三 | dd |')
  await clickCell(page, '甲')
  await clickMenu(app, ['格式', '表格', '整理表格'])

  await expect
    .poll(async () => await docText(page))
    .toBe(['| 甲     | b   |', '| ------ | --- |', '| 一二三 | dd  |'].join('\n'))
})

test('结构性编辑之后按撤销，文档一字不差地回到原样', async ({ app, page }) => {
  // 这条是「不持有第二状态」这个设计的验收：
  // widget 里存一份状态的做法，撤销之后状态与文本必然对不上
  await pasteText(page, TABLE)
  const before = await docText(page)

  await clickCell(page, '1')
  await clickMenu(app, ['格式', '表格', '在下方插入行'])
  await expect.poll(async () => (await docText(page)).split('\n').length).toBe(4)

  await clickCell(page, '1')
  await clickMenu(app, ['格式', '表格', '在右侧插入列'])
  await clickCell(page, '1')
  await clickMenu(app, ['格式', '表格', '本列居中'])

  await page.locator('.cm-content').click()
  for (let i = 0; i < 3; i++) await page.keyboard.press('ControlOrMeta+z')

  expect(await docText(page)).toBe(before)
})
