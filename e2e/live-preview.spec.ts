/**
 * 实时预览的端到端验证。
 *
 * 单元测试（packages/editor/test）验证的是「装饰算得对不对」；
 * 这里验证的是「在真实 Chromium 里，光标、DOM、输入法确实按预期工作」——
 * 那些只有在真浏览器里才会暴露的问题。
 */
import { docText, expect, resetDoc, test, visibleText } from './fixtures.js'

test.describe('基本渲染', () => {
  test('应用能启动并显示编辑区', async ({ page }) => {
    await expect(page.locator('.cm-content')).toBeVisible()
    await expect(page.locator('#status-name')).toContainText('未命名.md')
  })

  test('标题渲染为大字号，# 被隐藏', async ({ page }) => {
    await resetDoc(page, '# 一级标题\n\n正文')
    // 光标停在正文，标题行不激活
    await expect(page.locator('.cm-typo-h1')).toHaveCount(1)
    await expect(page.locator('.cm-typo-h1')).toHaveText('一级标题')
  })

  test('加粗文字带样式且标记不可见', async ({ page }) => {
    await resetDoc(page, '这是 **粗体** 内容\n\n第二段')
    const strong = page.locator('.cm-typo-strong')
    await expect(strong).toHaveCount(1)
    await expect(strong).toHaveText('粗体')
    expect(await visibleText(page)).toContain('这是 粗体 内容')
  })

  test('列表标记渲染为圆点', async ({ page }) => {
    await resetDoc(page, '- 第一项\n- 第二项\n\n段落')
    await expect(page.locator('.cm-typo-bullet').first()).toHaveText('•')
  })

  test('分隔线渲染为横线元素', async ({ page }) => {
    await resetDoc(page, '上文\n\n---\n\n下文')
    await expect(page.locator('.cm-typo-hr')).toHaveCount(1)
  })
})

test.describe('光标进入即显源码', () => {
  test('点进加粗文字后星号出现，移开后消失', async ({ page }) => {
    await resetDoc(page, '这是 **粗体** 内容\n\n第二段')

    // 光标在第二段时不显形
    expect(await visibleText(page)).not.toContain('**')

    // 用键盘把光标移进第一行的加粗区域
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    expect(await visibleText(page)).toContain('**')

    // 移回第二段，星号重新隐藏
    await page.keyboard.press('ControlOrMeta+End')
    expect(await visibleText(page)).not.toContain('**')
  })

  test('光标走到加粗区边界时，标记已经先一步显形', async ({ page }) => {
    // 这是「闭区间激活」这条规则最实际的价值：用户永远不会在看不见的标记里打字。
    // 也正因为有它，横向方向键几乎用不上 atomicRanges —— 详见
    // docs/design/02-editor-core.md §4.1
    await resetDoc(page, 'AB**粗**CD\n\n第二段')
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('ControlOrMeta+Home')
    expect(await visibleText(page)).not.toContain('**')

    await page.keyboard.press('ArrowRight') // A 之后
    await page.keyboard.press('ArrowRight') // B 之后，紧贴加粗区左边界
    expect(await visibleText(page)).toContain('**')
  })

  test('在加粗区边界输入，源码结构不被破坏', async ({ page }) => {
    await resetDoc(page, 'AB**粗**CD\n\n第二段')
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')

    expect(await docText(page)).toBe('ABX**粗**CD\n\n第二段')
  })
})

test.describe('编辑行为', () => {
  test('敲 # 空格立刻变成标题（源码优先模型的天然结果）', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('## 标题')
    await expect(page.locator('.cm-typo-h2')).toHaveCount(1)
  })

  test('回车续写列表标记', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('- 第一项')
    await page.keyboard.press('Enter')
    await page.keyboard.type('第二项')
    expect(await docText(page)).toBe('- 第一项\n- 第二项')
  })

  test('Ctrl+B 加粗选中文字', async ({ page }) => {
    await resetDoc(page, '重点')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+b')
    expect(await docText(page)).toBe('**重点**')
  })

  test('撤销能还原格式命令', async ({ page }) => {
    await resetDoc(page, '重点')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+b')
    await page.keyboard.press('ControlOrMeta+z')
    expect(await docText(page)).toBe('重点')
  })
})

test.describe('源码模式', () => {
  test('切换后所有标记都显形，文档内容一个字不变', async ({ page }) => {
    await resetDoc(page, '# 标题\n\n**粗体**与 `代码`')
    const before = await docText(page)

    await page.locator('#status-mode').click()
    await expect(page.locator('#status-mode')).toHaveText('源码模式')

    const visible = await visibleText(page)
    expect(visible).toContain('# 标题')
    expect(visible).toContain('**粗体**')
    expect(await docText(page)).toBe(before)

    await page.locator('#status-mode').click()
    await expect(page.locator('#status-mode')).toHaveText('实时预览')
    expect(await docText(page)).toBe(before)
  })
})

test.describe('状态栏', () => {
  test('编辑后出现未保存标记', async ({ page }) => {
    await resetDoc(page, '一些内容')
    await expect(page.locator('#status-name')).toContainText('●')
  })

  test('字数统计随输入更新', async ({ page }) => {
    await resetDoc(page, '中文四个字')
    await expect(page.locator('#status-stats')).toContainText('5 字')
  })
})
