/**
 * 输入法（IME）正确性 —— 目标 G1 的硬性门槛。
 *
 * 为什么这套用例值得单独一个文件、并且必须常跑：
 * 实时预览是靠替换 DOM 实现的，而输入法组合期间浏览器正把候选文字挂在
 * 那些 DOM 节点上。装饰一重建就会打断组合，表现为丢字、光标乱跳、候选框闪退。
 * 中文用户碰到一次就不会再用第二次 —— 这不是「以后优化」，是能不能发布的门槛。
 *
 * 实现手段：通过 CDP 的 Input.imeSetComposition / insertText 驱动真实的
 * 组合输入流程，而不是用 keyboard.type 假装。
 */
import { docText, expect, resetDoc, test } from './fixtures.js'
import type { Page } from '@playwright/test'

/** 模拟一次完整的输入法组合输入：先显示候选，再上屏。 */
async function composeText(page: Page, stages: string[], final: string): Promise<void> {
  const session = await page.context().newCDPSession(page)
  try {
    for (const stage of stages) {
      await session.send('Input.imeSetComposition', {
        text: stage,
        selectionStart: stage.length,
        selectionEnd: stage.length,
      })
    }
    await session.send('Input.insertText', { text: final })
  } finally {
    await session.detach()
  }
}

test.describe('中文拼音输入', () => {
  test('在普通段落里组合输入不丢字', async ({ page }) => {
    await resetDoc(page)
    await composeText(page, ['n', 'ni', 'nih', 'niha', 'nihao'], '你好')
    expect(await docText(page)).toBe('你好')
  })

  test('在被装饰的加粗区域内组合输入不丢字', async ({ page }) => {
    // 这是最容易炸的位置：光标周围的 ** 正处于「显形/隐藏」的切换边界上
    await resetDoc(page, '**粗体**')
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')

    await composeText(page, ['z', 'zh', 'zhong'], '中')
    expect(await docText(page)).toContain('中')
    expect(await docText(page)).toContain('粗体')
  })

  test('在标题行组合输入不丢字，且标题结构不被破坏', async ({ page }) => {
    await resetDoc(page, '# ')
    await page.keyboard.press('ControlOrMeta+End')
    await composeText(page, ['b', 'bi', 'biao', 'biaoti'], '标题')
    expect(await docText(page)).toBe('# 标题')
  })

  test('连续多次组合输入按顺序累积', async ({ page }) => {
    await resetDoc(page)
    await composeText(page, ['w', 'wo'], '我')
    await composeText(page, ['m', 'men'], '们')
    await composeText(page, ['h', 'hao'], '好')
    expect(await docText(page)).toBe('我们好')
  })

  test('组合中途取消不留下残留字符', async ({ page }) => {
    await resetDoc(page, '前置')
    await page.keyboard.press('ControlOrMeta+End')

    const session = await page.context().newCDPSession(page)
    try {
      await session.send('Input.imeSetComposition', {
        text: 'nihao',
        selectionStart: 5,
        selectionEnd: 5,
      })
      // 空字符串 = 取消组合
      await session.send('Input.imeSetComposition', {
        text: '',
        selectionStart: 0,
        selectionEnd: 0,
      })
    } finally {
      await session.detach()
    }

    expect(await docText(page)).toBe('前置')
  })
})

test.describe('日文与韩文', () => {
  test('日文假名转换', async ({ page }) => {
    await resetDoc(page)
    await composeText(page, ['か', 'かん', 'かんじ'], '漢字')
    expect(await docText(page)).toBe('漢字')
  })

  test('韩文组字', async ({ page }) => {
    await resetDoc(page)
    await composeText(page, ['ㅎ', '하', '한'], '한글')
    expect(await docText(page)).toBe('한글')
  })
})

test.describe('组合输入与实时预览的交互', () => {
  test('组合结束后装饰立刻恢复正常', async ({ page }) => {
    await resetDoc(page)
    await page.keyboard.type('**')
    await composeText(page, ['c', 'cu'], '粗')
    await page.keyboard.type('**')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('第二段')

    expect(await docText(page)).toBe('**粗**\n\n第二段')
    // 光标已移出，加粗标记应当重新隐藏
    await expect(page.locator('.cm-mosu-strong')).toHaveText('粗')
  })
})
