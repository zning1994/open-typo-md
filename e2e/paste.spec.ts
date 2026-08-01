/**
 * 粘贴富文本（docs/design/03 §8）。
 *
 * 转换本身有 37 条单测（`packages/import`）。这里验的是**接线**：
 * 事件有没有被接住、和图片粘贴 / 纯文本粘贴有没有打架、
 * 插进去的东西在实时预览里是不是真的变成了对应的结构。
 *
 * 用合成的 `paste` 事件而不是系统剪贴板：无头环境里的剪贴板既不稳定，
 * 也塞不进「同时带 text/html 和 text/plain」这种真实剪贴板的形态 ——
 * 而这恰恰是本功能全部判断的依据。产品这一侧一行都没绕开。
 */
import { docText, expect, resetDoc, test } from './fixtures.js'
import type { Page } from '@playwright/test'

/**
 * 往编辑器里丢一个真实形态的剪贴板事件。
 *
 * 刻意**不**在这里点一下编辑器：那会清掉调用方刚设好的选区，
 * 而「粘贴替换选中内容」正是要验的行为之一。
 */
async function paste(page: Page, data: { html?: string; text?: string }): Promise<void> {
  await page.evaluate((payload) => {
    const transfer = new DataTransfer()
    if (payload.html !== undefined) transfer.setData('text/html', payload.html)
    if (payload.text !== undefined) transfer.setData('text/plain', payload.text)
    document.querySelector('.cm-content')!.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, data)
}

test('从网页粘过来的结构变成 Markdown', async ({ page }) => {
  await resetDoc(page)
  await paste(page, {
    html: '<h1>标题</h1><ul><li>甲</li><li>乙</li></ul><p>看 <a href="https://x.com">这里</a></p>',
    text: '标题\n甲\n乙\n看 这里',
  })

  const text = await docText(page)
  expect(text).toContain('# 标题')
  expect(text).toContain('- 甲')
  expect(text).toContain('[这里](https://x.com)')
})

test('粘进来的表格在实时预览里真的是表格', async ({ page }) => {
  await resetDoc(page)
  await paste(page, {
    html: '<table><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><p>后文</p>',
    text: '甲 乙 1 2 后文',
  })

  // 光标停在「后文」上，表格不处于激活态，因此应当以渲染形态呈现。
  // 两行而不是三行：分隔行在渲染态里是藏起来的（见 tables.spec.ts）
  await expect(page.locator('.cm-typo-tr')).toHaveCount(2)
})

test('Google 文档的假粗体外壳不会让整篇变粗', async ({ page }) => {
  await resetDoc(page)
  await paste(page, {
    html: '<b style="font-weight:normal" id="docs-internal-guid-1"><h1>标题</h1><p>正文<span style="font-weight:700">只有这里粗</span></p></b>',
    text: '标题\n正文只有这里粗',
  })

  const text = await docText(page)
  expect(text).toContain('# 标题')
  expect(text).toContain('**只有这里粗**')
  expect(text).not.toContain('**标题**')
})

test('样式表内容不会跟着粘进文档', async ({ page }) => {
  await resetDoc(page)
  await paste(page, {
    html: '<style>h1{font-size:32px;color:red}</style><h1>标题</h1>',
    text: '标题',
  })

  const text = await docText(page)
  expect(text).toContain('# 标题')
  expect(text).not.toContain('font-size')
})

test('代码编辑器复制来的带色 div 走纯文本 —— 代码一个字符都不变', async ({ page }) => {
  await resetDoc(page)
  const code = 'const a = 1'
  await paste(page, {
    html: `<div style="color:#d4d4d4"><div><span style="color:#569cd6">const</span><span> a = 1</span></div></div>`,
    text: code,
  })

  expect(await docText(page)).toBe(code)
})

test('只有纯文本时按原样插入，不做任何转换', async ({ page }) => {
  await resetDoc(page)
  await paste(page, { text: '**本来就是 markdown**' })

  expect(await docText(page)).toBe('**本来就是 markdown**')
})

test('javascript: 链接只留文字', async ({ page }) => {
  await resetDoc(page)
  await paste(page, {
    html: '<h1><a href="javascript:alert(1)">点我</a></h1>',
    text: '点我',
  })

  // 断言写成完整相等：只查「不含 javascript」的话，
  // 转换根本没发生（退回纯文本）时这条用例也会绿
  expect(await docText(page)).toBe('# 点我')
})

test('粘贴替换掉选中的内容，且撤销一次就回到粘贴前', async ({ page }) => {
  await resetDoc(page, '旧内容')
  await page.keyboard.press('ControlOrMeta+a')
  await paste(page, { html: '<h1>新标题</h1>', text: '新标题' })

  expect(await docText(page)).toBe('# 新标题')

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await docText(page)).toBe('旧内容')
})
