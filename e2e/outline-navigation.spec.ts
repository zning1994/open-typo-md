/**
 * 大纲的长文导航：过滤、折叠、可调宽度、当前节滚进视野（issue #41）。
 *
 * 这一组最要紧的一条不是「功能有没有」，而是**这些操作一个字都不碰文档**。
 * 大纲是只读导航视图，过滤和折叠只影响画哪几个 `<li>`；一旦它开始动文本
 * 或者动光标，它就变成了一个会悄悄改稿子的东西。所以每一组末尾都回头看
 * 源码和光标位置。
 */
import { ACTIVE_CONTENT, clickMenu, docText, expect, test } from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

/** 三层结构，且**故意跳级**（H1 之后直接 H3）—— 真实文档里很常见。 */
const DOC = [
  '# 总纲',
  '',
  '正文一。',
  '',
  '## 第一章',
  '',
  '正文二。',
  '',
  '### 第一节 目标',
  '',
  '正文三。',
  '',
  '### 第二节 范围',
  '',
  '正文四。',
  '',
  '## 第二章',
  '',
  '正文五。',
  '',
  '### 第三节 目标',
  '',
  '正文六。',
].join('\n')

const items = (page: Page) => page.locator('.mosu-outline__item')
const links = (page: Page) => page.locator('.mosu-outline__link')

/**
 * 开大纲要走**原生菜单**，不能敲 ⌘⇧E。
 *
 * 真正拦住那个组合键的是原生菜单的 accelerator，而 Playwright 送进去的是
 * 合成按键 —— 菜单收不到，键落进编辑器。这个坑 `shared/keys.ts` 里写过一次。
 */
async function openOutline(
  app: ElectronApplication,
  page: Page,
  doc = DOC,
  expected = 6,
): Promise<void> {
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.evaluate((text) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', text)
    document
      .querySelector('.tab-page:not([hidden]) .cm-content')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
  }, doc)
  await page.waitForTimeout(300)

  if (!(await page.locator('.mosu-outline').isVisible())) {
    await clickMenu(app, ['视图', '大纲'])
  }
  await expect(page.locator('.mosu-outline')).toBeVisible()
  await expect(items(page)).toHaveCount(expected)
}

test.describe('过滤', () => {
  test('输入关键词只留下匹配的标题', async ({ app, page }) => {
    await openOutline(app, page)
    await page.locator('.mosu-outline__filter').fill('范围')

    await expect(links(page).filter({ hasText: '第二节 范围' })).toHaveCount(1)
    await expect(links(page).filter({ hasText: '第一节 目标' })).toHaveCount(0)
  })

  test('匹配项的祖先也留着 —— 否则结果是一堆没有上下文的孤条', async ({ app, page }) => {
    await openOutline(app, page)
    await page.locator('.mosu-outline__filter').fill('范围')

    // 「第二节 范围」的祖先链是 第一章 → 总纲，两条都该在
    await expect(links(page).filter({ hasText: '第一章' })).toHaveCount(1)
    await expect(links(page).filter({ hasText: '总纲' })).toHaveCount(1)
    // 但另一条 H2 不该在 —— 它既不匹配也不是祖先
    await expect(links(page).filter({ hasText: '第二章' })).toHaveCount(0)
  })

  test('一个都搜不到时说清楚，而不是留一片空白', async ({ app, page }) => {
    await openOutline(app, page)
    await page.locator('.mosu-outline__filter').fill('这个词不存在')
    await expect(page.locator('.mosu-outline__empty')).toHaveText('没有匹配的标题')
  })

  test('过滤完文档一个字节没变，光标也没动', async ({ app, page }) => {
    await openOutline(app, page)
    // 先把光标放到一个已知位置。**要等状态栏真的跟上再取快照** ——
    // 它是防抖更新的，敲完立刻读到的还是上一次的值，于是这条断言会拿
    // 一个陈旧的期望值去比，红得莫名其妙（第一版就是这么翻的）
    await page.locator(ACTIVE_CONTENT).click()
    await page.keyboard.press('ControlOrMeta+Home')
    await expect(page.locator('#status-stats')).toContainText('1:1')
    const before = await page.locator('#status-stats').textContent()

    await page.locator('.mosu-outline__filter').fill('目标')
    await page.waitForTimeout(300)

    expect(await docText(page)).toBe(DOC)
    expect(await page.locator('#status-stats').textContent()).toBe(before)
  })
})

test.describe('折叠', () => {
  test('折叠一节，它的下级不再显示；展开回来又都在', async ({ app, page }) => {
    await openOutline(app, page)

    // 「第一章」那一行的三角
    const chapter = items(page).filter({ hasText: '第一章' })
    await chapter.locator('.mosu-outline__twisty').click()

    await expect(links(page).filter({ hasText: '第一节 目标' })).toHaveCount(0)
    await expect(links(page).filter({ hasText: '第二节 范围' })).toHaveCount(0)
    // 别的章不受影响
    await expect(links(page).filter({ hasText: '第三节 目标' })).toHaveCount(1)

    await chapter.locator('.mosu-outline__twisty').click()
    await expect(links(page).filter({ hasText: '第一节 目标' })).toHaveCount(1)
  })

  test('没有下级的行不画三角 —— 画了就是让人扑空', async ({ app, page }) => {
    await openOutline(app, page)
    const leaf = items(page).filter({ hasText: '第二节 范围' })
    await expect(leaf.locator('.mosu-outline__twisty')).toHaveText('')
  })

  test('全部折叠只剩顶层，全部展开都回来', async ({ app, page }) => {
    await openOutline(app, page)

    await page.locator('.mosu-outline__tool[aria-label="全部折叠"]').click()
    await expect(items(page)).toHaveCount(1)
    await expect(links(page).first()).toContainText('总纲')

    await page.locator('.mosu-outline__tool[aria-label="全部展开"]').click()
    await expect(items(page)).toHaveCount(6)
  })

  test('按层级折叠：折到 H2 以下，H3 收起来而 H2 还在', async ({ app, page }) => {
    await openOutline(app, page)
    await page.locator('.mosu-outline__level', { hasText: 'H2' }).click()

    await expect(links(page).filter({ hasText: '第一章' })).toHaveCount(1)
    await expect(links(page).filter({ hasText: '第二章' })).toHaveCount(1)
    await expect(links(page).filter({ hasText: '第一节' })).toHaveCount(0)
  })

  test('过滤时忽略折叠 —— 正在找东西，还让折叠挡着毫无道理', async ({ app, page }) => {
    await openOutline(app, page)
    await page.locator('.mosu-outline__tool[aria-label="全部折叠"]').click()
    await expect(items(page)).toHaveCount(1)

    await page.locator('.mosu-outline__filter').fill('范围')
    await expect(links(page).filter({ hasText: '第二节 范围' })).toHaveCount(1)
  })

  test('折叠完文档一个字节没变', async ({ app, page }) => {
    await openOutline(app, page)
    await page.locator('.mosu-outline__tool[aria-label="全部折叠"]').click()
    await page.waitForTimeout(200)
    expect(await docText(page)).toBe(DOC)
  })
})

test.describe('跳转与高亮', () => {
  test('点一条跳过去，光标落在那个标题上', async ({ app, page }) => {
    await openOutline(app, page)
    await links(page).filter({ hasText: '第三节 目标' }).click()
    await page.waitForTimeout(300)

    // 「### 第三节 目标」在第 21 行
    await expect(page.locator('#status-stats')).toContainText('21')
  })

  test('折叠之后跳转仍然落在对的位置', async ({ app, page }) => {
    await openOutline(app, page)
    await page.locator('.mosu-outline__level', { hasText: 'H2' }).click()
    await links(page).filter({ hasText: '第二章' }).click()
    await page.waitForTimeout(300)

    await expect(page.locator('#status-stats')).toContainText('17')
  })
})

test.describe('可调宽度', () => {
  test('拖左边界能改宽，且改的只是面板', async ({ app, page }) => {
    await openOutline(app, page)

    const before = await page.locator('.mosu-outline').boundingBox()
    const handle = await page.locator('.mosu-outline__handle').boundingBox()
    expect(before).not.toBeNull()
    expect(handle).not.toBeNull()

    // 往左拖 = 变宽（面板在右侧）
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle!.x - 80, handle!.y + handle!.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    const after = await page.locator('.mosu-outline').boundingBox()
    expect(after!.width).toBeGreaterThan(before!.width + 40)
    // 文档没被这一拖碰过
    expect(await docText(page)).toBe(DOC)
  })

  test('宽度记得住 —— 新窗口沿用同一个宽度', async ({ app, page }) => {
    await openOutline(app, page)
    const handle = (await page.locator('.mosu-outline__handle').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 60, handle.y + handle.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(400)

    const width = (await page.locator('.mosu-outline').boundingBox())!.width
    // 偏好是异步写盘的，读回来的值应当已经被夹进合法区间
    const stored = await page.evaluate(() => window.mosu.settings.get('panel.outline.width'))
    expect(Math.abs((stored as number) - width)).toBeLessThanOrEqual(2)
  })
})

test.describe('章节编号', () => {
  test('打开之后标题前面出现 1 / 1.1 这样的编号', async ({ app, page }) => {
    await openOutline(app, page)
    await page.locator('.mosu-outline__tool[aria-label="显示章节编号"]').click()

    await expect(links(page).first()).toContainText('1 总纲')
    await expect(links(page).filter({ hasText: '第一章' })).toContainText('1.1')
  })

  test('跳级的层次也编得出来 —— H1 之后直接 H3 是合法的', async ({ app, page }) => {
    await openOutline(app, page, '# 一级\n\n正文\n\n### 直接三级\n\n正文\n', 2)
    await page.locator('.mosu-outline__tool[aria-label="显示章节编号"]').click()

    // 缺的那一层记 0，而不是把编号算塌成 `1.1`
    await expect(links(page).nth(1)).toContainText('1.0.1')
  })
})
