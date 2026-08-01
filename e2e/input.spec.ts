/**
 * 输入行为：自动配对与选中包裹。
 *
 * 全部放 e2e 而不是单元测试，理由不是「懒得写」而是「单元测试测不到真东西」——
 * 这些行为的入口是 `EditorView.inputHandler`，它认的是浏览器实际派发的输入
 * 事件。真正的风险（跟 closeBrackets 抢不抢、输入法组合期间会不会误触发）
 * 只有真键盘敲出来才算数。
 */
import { docText, expect, resetDoc, test } from './fixtures.js'

test.describe('选中包裹', () => {
  test('选中文字敲 * 变斜体', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('重点内容')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('*')

    expect(await docText(page)).toBe('*重点内容*')
  })

  test('连敲两次 * 变粗体 —— 包裹后选区保持在内容上', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('重点内容')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('*')
    await page.keyboard.type('*')

    expect(await docText(page)).toBe('**重点内容**')
  })

  for (const [mark, expected] of [
    ['_', '_内容_'],
    ['~', '~内容~'],
    ['`', '`内容`'],
  ] as const) {
    test(`选中文字敲 ${mark} 同样包裹`, async ({ page }) => {
      await resetDoc(page)
      await page.keyboard.type('内容')
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type(mark)

      expect(await docText(page)).toBe(expected)
    })
  }

  test('括号类也包裹（这条由上游 closeBrackets 提供）', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('内容')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('(')

    expect(await docText(page)).toBe('(内容)')
  })

  test('代码块里不包裹 —— 代码里的 * 就是 *', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('```\n')
    await page.keyboard.type('a * b')
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.keyboard.type('*')

    // 期望是「替换掉选区」的默认行为，而不是包裹成 `*a * b*`
    expect(await docText(page)).toBe('```\n*')
  })

  test('包裹可以撤销，一次就回到原样', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('内容')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('*')
    expect(await docText(page)).toBe('*内容*')

    await page.keyboard.press('ControlOrMeta+z')
    expect(await docText(page)).toBe('内容')
  })
})

test.describe('自动配对', () => {
  test('空选区敲 ( 自动补上 )', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('看这里 (')

    expect(await docText(page)).toBe('看这里 ()')
  })

  test('紧接着敲 ) 会跳过去，而不是插出两个', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('看这里 ()')

    expect(await docText(page)).toBe('看这里 ()')
  })

  test('单引号不配对 —— 英文正文里它是撇号', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type("don't stop")

    expect(await docText(page)).toBe("don't stop")
  })

  test('行首敲 * 起列表，不会被补成 **', async ({ page }) => {
    // 强调类在空选区时绝不自动补全，这条是那个决定的直接体现
    await resetDoc(page)
    await page.keyboard.type('* 列表项')

    expect(await docText(page)).toBe('* 列表项')
  })

  test('连敲三个反引号得到围栏，不是一堆多余的反引号', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('```')

    expect(await docText(page)).toBe('```')
  })

  test('波浪线不配对（路径里的 ~/ 很常见）', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('见 ~/文档/说明.md')

    expect(await docText(page)).toBe('见 ~/文档/说明.md')
  })

  test('下划线不配对（标识符里很常见）', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('变量 some_var_name')

    expect(await docText(page)).toBe('变量 some_var_name')
  })
})
