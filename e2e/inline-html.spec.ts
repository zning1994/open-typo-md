/**
 * 行内 HTML 的渲染（路线图 M4.5 #6）。
 *
 * 规则本身有 26 条单测。这里验的是**只有真浏览器里才成立**的那一件事：
 * 渲染结果确实是「类名 + 文本」，**没有任何一个用户写的标签变成了真元素**。
 *
 * 这条断言就是整个功能的安全前提。单测断言不到它 —— 单测看的是装饰对象，
 * 而「有没有元素被造出来」只有在真 DOM 里才问得出来。
 */
import {
  ACTIVE_CONTENT,
  expect,
  openSettings,
  pasteText,
  test,
  visibleText,
} from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

/** 编辑区里所有元素的标签名。 */
async function tagNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.tab-page:not([hidden]) .cm-content *')).map((el) =>
      el.tagName.toLowerCase(),
    ),
  )
}

test('认得的标签渲染成类名，源码里的尖括号不再显示', async ({ page }) => {
  await pasteText(page, '按 <kbd>Esc</kbd> 退出，H<sub>2</sub>O 是水')

  await expect(page.locator(`${ACTIVE_CONTENT} .cm-mosu-html-kbd`)).toHaveText('Esc')
  await expect(page.locator(`${ACTIVE_CONTENT} .cm-mosu-html-sub`)).toHaveText('2')
  expect(await visibleText(page)).toBe('按 Esc 退出，H2O 是水')
})

test('渲染出来的只有 span，用户写的标签一个都没变成真元素', async ({ page }) => {
  // 这一条是安全前提本身：实现里没有 innerHTML，产物里就不该出现
  // 任何一个来自文档的元素
  await pasteText(page, '正文 <b>粗</b> 与 <kbd>K</kbd> 与 <mark>高亮</mark>')

  const tags = await tagNames(page)
  expect(tags).not.toContain('b')
  expect(tags).not.toContain('kbd')
  expect(tags).not.toContain('mark')
})

test('危险标签既不渲染，也不进 DOM —— 按字面文本显示', async ({ page }) => {
  await pasteText(page, '<script>alert(1)</script> 与 <img src=x onerror=alert(1)>')

  const tags = await tagNames(page)
  expect(tags).not.toContain('script')
  expect(tags).not.toContain('img')
  // 一个字都没吞（原则 P2）
  expect(await visibleText(page)).toBe(
    '<script>alert(1)</script> 与 <img src=x onerror=alert(1)>',
  )
})

test('光标进去露出标签，出来又收起来', async ({ page }) => {
  await pasteText(page, '正文 <b>粗体</b> 收尾')
  expect(await visibleText(page)).toBe('正文 粗体 收尾')

  await page.locator(`${ACTIVE_CONTENT} .cm-mosu-html-b`).click()
  await expect.poll(() => visibleText(page)).toBe('正文 <b>粗体</b> 收尾')
})

test('`<br>` 真的换了一行', async ({ page }) => {
  await pasteText(page, '上一句<br>下一句')

  // 换行发生在**一个** cm-line 内部（源码仍是一行），所以不能数行数，
  // 得看两段文字的纵坐标
  const boxes = await page.evaluate(() => {
    const content = document.querySelector('.tab-page:not([hidden]) .cm-content')!
    const range = document.createRange()
    const text = content.textContent ?? ''
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    const tops: number[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue
      range.selectNodeContents(node)
      tops.push(Math.round(range.getBoundingClientRect().top))
    }
    return { tops, text }
  })
  expect(boxes.text).toContain('上一句')
  expect(new Set(boxes.tops).size).toBeGreaterThan(1)
})

async function setRenderInlineHtml(
  app: ElectronApplication,
  page: Page,
  on: boolean,
): Promise<void> {
  await openSettings(app)
  await expect(page.locator('.mosu-settings')).toBeVisible()
  const box = page
    .locator('.mosu-settings__row')
    .filter({ hasText: '渲染行内 HTML' })
    .locator('input')
  await box.setChecked(on)
  await page.keyboard.press('Escape')
  await expect(page.locator('.mosu-settings')).toBeHidden()
}

test('设置里关掉之后，已经开着的标签立刻退回原文显示', async ({ app, page }) => {
  await pasteText(page, '正文 <b>粗体</b> 收尾')
  expect(await visibleText(page)).toBe('正文 粗体 收尾')

  // 「渲染规则」跟「新标签默认视图」不同，它必须立刻作用到当前这篇文档上 ——
  // 用户勾掉它就是想现在看见自己文件里写的是什么
  await setRenderInlineHtml(app, page, false)
  await expect.poll(() => visibleText(page)).toBe('正文 <b>粗体</b> 收尾')

  await setRenderInlineHtml(app, page, true)
  await expect.poll(() => visibleText(page)).toBe('正文 粗体 收尾')
})
