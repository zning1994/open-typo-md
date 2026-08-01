/**
 * GFM 里需要真实 DOM 才能验的部分。
 *
 * 重点是**任务列表的复选框** —— 它是第一个可交互的 widget，也是第一次真刀真枪
 * 兑现 docs/design/02 §6 的铁律「widget 不持有状态，一切改动转成对主文档的
 * transaction」。这条铁律成立与否，单元测试看不出来，只有点一下再按 ⌘Z 才知道。
 */
import { docText, expect, resetDoc, test, visibleText } from './fixtures.js'

test('复选框点一下就勾上，改的是源码里的 [ ]', async ({ page }) => {
  await resetDoc(page)
  await page.keyboard.type('- [ ] 待办事项\n')
  await page.keyboard.type('结尾')

  await page.locator('.cm-typo-task').first().click()

  expect(await docText(page)).toContain('- [x] 待办事项')
})

test('再点一下取消勾选', async ({ page }) => {
  await resetDoc(page)
  await page.keyboard.type('- [x] 已完成\n')
  await page.keyboard.type('结尾')

  await page.locator('.cm-typo-task').first().click()
  expect(await docText(page)).toContain('- [ ] 已完成')
})

test('勾选可以撤销 —— 走的是普通 transaction，不是 widget 私有状态', async ({ page }) => {
  await resetDoc(page)
  await page.keyboard.type('- [ ] 待办\n')
  await page.keyboard.type('结尾')

  await page.locator('.cm-typo-task').first().click()
  expect(await docText(page)).toContain('- [x] 待办')

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await docText(page)).toContain('- [ ] 待办')
})

test('回车续写任务项，新项默认未勾选', async ({ page }) => {
  await resetDoc(page)
  await page.keyboard.type('- [x] 已完成')
  await page.keyboard.press('Enter')
  await page.keyboard.type('下一项')

  // 续写出来的必须是 `[ ]` 而不是照抄 `[x]` —— 新任务默认没做完
  expect(await docText(page)).toBe('- [x] 已完成\n- [ ] 下一项')
})

test('多个任务项各点各的，不会串位', async ({ page }) => {
  // 相邻两个未勾选的任务 widget 的 eq() 相等、会被复用。
  // 位置若是构造时存下来的，点第二个会去改第一个 —— 这条用例盯的就是它。
  await resetDoc(page)
  await page.keyboard.type('- [ ] 甲')
  await page.keyboard.press('Enter') // 回车自动续写 `- [ ] `
  await page.keyboard.type('乙')
  await page.keyboard.press('Enter')
  await page.keyboard.type('丙')

  await page.locator('.cm-typo-task').nth(1).click()

  expect(await docText(page)).toBe('- [ ] 甲\n- [x] 乙\n- [ ] 丙')
})

test('点复选框不会把光标挪进标记里导致它当场消失', async ({ page }) => {
  // 默认行为会把光标放到点击位置，于是这一行显形、复选框被源码替换掉，
  // 第二次点击就落空了。widget 里 preventDefault 挡的就是这个。
  await resetDoc(page)
  await page.keyboard.type('- [ ] 待办\n')
  await page.keyboard.type('结尾')

  const box = page.locator('.cm-typo-task').first()
  await box.click()
  await expect(page.locator('.cm-typo-task')).toHaveCount(1)
  await box.click()

  expect(await docText(page)).toContain('- [ ] 待办')
})

test('删除线、脚注、实体在真实渲染下的样子', async ({ page }) => {
  await resetDoc(page)
  await page.keyboard.type('~~废弃~~ 和 A&amp;B 还有引用[^1]\n')
  await page.keyboard.type('\n')
  await page.keyboard.type('[^1]: 脚注内容\n')
  await page.keyboard.type('结尾')

  const shown = await visibleText(page)
  expect(shown).toContain('废弃')
  expect(shown).not.toContain('~~')
  expect(shown).toContain('A&B')
  expect(shown).not.toContain('&amp;')
  expect(shown).toContain('引用1')
  // 定义行整行保留：标签是内容（第几条），不是纯标记
  expect(shown).toContain('[^1]: 脚注内容')
})

test('源码保真：GFM 的新语法一次过，字节不变', async ({ page }) => {
  // 刻意避开列表 —— 回车会自动续写列表标记，那是**正确**的输入行为，
  // 但会让「照着敲一遍」这种写法敲出别的东西。任务列表的续写另有用例覆盖。
  const doc = [
    '| a | b |',
    '| --- | ---: |',
    '| 1 | 2 |',
    '',
    '~~删除~~ 与 www.example.com 与 A&amp;B 与 \\*字面星号\\*',
    '',
    '引用[^注]。',
    '',
    '[^注]: 脚注内容',
  ].join('\n')

  await resetDoc(page)
  await page.keyboard.type(doc)

  expect(await docText(page)).toBe(doc)
})

test.describe('数学公式', () => {
  test('行内公式渲染成 KaTeX', async ({ page }) => {
    await resetDoc(page, '质能方程 $E = mc^2$ 很有名\n\n第二段')

    // KaTeX 是懒加载的，第一次要等 chunk 下来
    await expect(page.locator('.cm-typo-math .katex')).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('.cm-typo-math')).not.toHaveClass(/--pending/)
  })

  test('块级公式整块渲染，居中', async ({ page }) => {
    await resetDoc(page, '前文\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n后文')

    const block = page.locator('.cm-typo-math--block')
    await expect(block).toHaveCount(1, { timeout: 15_000 })
    expect(await block.evaluate((el) => getComputedStyle(el).textAlign)).toBe('center')
  })

  test('光标进入公式时还原成源码', async ({ page }) => {
    await resetDoc(page, '公式 $a + b$ 结束\n\n第二段')
    await expect(page.locator('.cm-typo-math .katex')).toHaveCount(1, { timeout: 15_000 })

    await page.locator('.cm-typo-math').click()
    await expect(page.locator('.cm-typo-math')).toHaveCount(0)
    expect(await docText(page)).toContain('$a + b$')
  })

  test('写错的公式标红显示原文，不留白也不崩', async ({ page }) => {
    // throwOnError: false —— 用户看到的是自己写的东西加一个错误提示
    await resetDoc(page, '错误公式 $\\frac{1}$ 在这\n\n第二段')

    await expect(page.locator('.cm-typo-math')).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('.cm-typo-math')).not.toBeEmpty()
  })

  test('源码保真：公式一个字节都没变', async ({ page }) => {
    const doc = '行内 $E = mc^2$ 与\n\n$$\n\\sum_{i=1}^n i\n$$\n\n结束'
    await resetDoc(page)
    await page.keyboard.type(doc)

    expect(await docText(page)).toBe(doc)
  })

  test('货币金额不会被渲染成公式', async ({ page }) => {
    await resetDoc(page, '我花了 $5 买了 $10 的东西\n\n第二段')
    await expect(page.locator('.cm-typo-math')).toHaveCount(0)
  })
})
