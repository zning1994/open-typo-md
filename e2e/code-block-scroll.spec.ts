/**
 * 代码块的横向滚动（issue #2）。
 *
 * 这一组必须是 E2E：三个症状全部由**真实布局**决定 —— 行有没有滚、光标被画在
 * 哪个坐标、视口有没有被撑出横向滚动空间。单测里没有布局，量出来的都是 0。
 *
 * 报告里的三个症状是同一个原因：**没有人把行滚到该滚的位置**。
 * 修好之后另外两个（视口在滚、高亮跑到块外）自动消失，所以这里三条都验。
 */
import { ACTIVE_PAGE, expect, test } from './fixtures.js'
import type { Page } from '@playwright/test'

/** 一行足够长、且能按内容定位到深列的代码。 */
const MARKER = 'MARKER_DEEP'
const HEAD = 'HEAD_MARK'
const LONG = `// ${HEAD} ${'a'.repeat(80)}${MARKER}${'b'.repeat(200)}`
const LONG2 = `const Y = "${'c'.repeat(80)}TAIL_DEEP${'d'.repeat(200)}";`

const DOC = `# 标题\n\n正文段落。\n\n\`\`\`js\nconst SHORT = 1;\n${LONG}\nconst MID = 2;\n${LONG2}\nconst SHORT2 = 3;\n\`\`\`\n\n块后的正文。\n`

async function paste(page: Page, text: string): Promise<void> {
  await page.locator(`${ACTIVE_PAGE} .cm-content`).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.evaluate((doc) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', doc)
    document
      .querySelector('.tab-page:not([hidden]) .cm-content')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
  }, text)
  await page.waitForTimeout(300)
}

/** 一次性把要断言的几何量取出来 —— 分开取会被中间的重排搞乱。 */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('.tab-page:not([hidden])') as HTMLElement
    const scroller = root.querySelector('.cm-scroller') as HTMLElement
    const codeLines = [...root.querySelectorAll('.cm-mosu-code-block')] as HTMLElement[]
    const heading = [...root.querySelectorAll('.cm-line')].find((l) =>
      l.textContent?.includes('标题'),
    ) as HTMLElement | undefined
    const caret = root.querySelector('.cm-cursorLayer > .cm-cursor') as HTMLElement | null

    // 选区**起点**的坐标。注意它跟插入符（= 选区末尾）不是一回事：
    // 用查找跳过去之后两者相差整个匹配文本的宽度。
    // 一开始拿这两个数互相断言过，差 95px —— 那正好是 `MARKER_DEEP` 这 11 个
    // 字符在 0.9em 等宽下的宽度，不是 bug。记在这里免得后来的人再验一次。
    const selection = window.getSelection()
    let trueCaretX: number | null = null
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0).cloneRange()
      const rects = range.getClientRects()
      const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect()
      if (rect) trueCaretX = Math.round(rect.x)
    }

    // 有横向滚动余量的那些行 —— 短行的 scrollLeft 恒为 0（浏览器会夹住），
    // 拿它们做断言只会得到噪声
    const scrollable = codeLines.filter((l) => l.scrollWidth > l.clientWidth + 1)
    const first = scrollable[0]
    return {
      scrollerLeft: scroller.scrollLeft,
      // scrollWidth 超出 clientWidth 就意味着视口获得了横向滚动空间 ——
      // 那正是「标题跟着左移」的前提
      scrollerOverflow: scroller.scrollWidth - scroller.clientWidth,
      headingX: heading ? Math.round(heading.getBoundingClientRect().x) : null,
      caretX: caret ? Math.round(caret.getBoundingClientRect().x) : null,
      trueCaretX,
      scrollableCount: scrollable.length,
      scrollLefts: scrollable.map((l) => l.scrollLeft),
      blockLeft: first ? Math.round(first.getBoundingClientRect().left) : null,
      blockRight: first ? Math.round(first.getBoundingClientRect().right) : null,
    }
  })
}

/** 用查找跳到长行深处的某个标记上。 */
async function jumpTo(page: Page, needle: string): Promise<void> {
  await page.locator(`${ACTIVE_PAGE} .cm-content`).click()
  await page.keyboard.press('ControlOrMeta+f')
  await page.waitForTimeout(200)
  await page.keyboard.type(needle)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

test('跳到长行深处：代码行真的滚了，而不是视口在滚', async ({ page }) => {
  await paste(page, DOC)
  await page.keyboard.press('ControlOrMeta+Home')
  await page.waitForTimeout(300)

  const before = await geometry(page)
  expect(before.scrollableCount).toBeGreaterThan(0)
  expect(before.scrollLefts.every((v) => v === 0)).toBe(true)

  await jumpTo(page, MARKER)
  const after = await geometry(page)

  // 1. 代码行滚了 —— 这是本体，另外两条都是它的后果
  expect(Math.max(...after.scrollLefts)).toBeGreaterThan(0)

  // 2. 视口没动：标题的 x 不变，滚动条位置不变
  expect(after.headingX).toBe(before.headingX)
  expect(after.scrollerLeft).toBe(0)
})

test('插入符落在代码块内部，不会画到块外的空白上', async ({ page }) => {
  await paste(page, DOC)
  await page.keyboard.press('ControlOrMeta+Home')
  await jumpTo(page, MARKER)

  const g = await geometry(page)
  expect(g.caretX).not.toBeNull()
  expect(g.blockLeft).not.toBeNull()

  // 这一条是报告里最刺眼的症状：高亮跑到代码块右边界外的空白页上。
  // 修之前实测 caretX=957 而块的右边界是 862
  expect(g.caretX!).toBeGreaterThanOrEqual(g.blockLeft!)
  expect(g.caretX!).toBeLessThanOrEqual(g.blockRight!)
})

test('视口始终不获得横向滚动空间 —— 「整页空白」就是这么来的', async ({ page }) => {
  await paste(page, DOC)
  await page.keyboard.press('ControlOrMeta+Home')

  // 跳两次，跳到不同长行的深处；任何一次都不该把视口撑出横向滚动
  for (const needle of [MARKER, 'TAIL_DEEP']) {
    await jumpTo(page, needle)
    const g = await geometry(page)
    expect(g.scrollerOverflow).toBeLessThanOrEqual(0)
    expect(g.scrollerLeft).toBe(0)
  }
})

test('同一个块里的长行滚到同一个偏移', async ({ page }) => {
  await paste(page, DOC)
  await page.keyboard.press('ControlOrMeta+Home')
  await jumpTo(page, MARKER)

  const g = await geometry(page)
  // 短行没有滚动余量、浏览器会把 scrollLeft 夹回 0，所以只看有余量的那些。
  // 它们必须一致 —— 不一致就是「块内各行错位」，报告里提到的另一个形态
  const distinct = new Set(g.scrollLefts)
  expect(distinct.size).toBe(1)
  expect([...distinct][0]).toBeGreaterThan(0)
})

test('光标回到同一行的浅列时，代码块滚回最左边', async ({ page }) => {
  await paste(page, DOC)
  await page.keyboard.press('ControlOrMeta+Home')

  await jumpTo(page, MARKER)
  expect(Math.max(...(await geometry(page)).scrollLefts)).toBeGreaterThan(0)

  // 跳回**同一行**靠前的位置。滚不回去的话，用户会看着一片被截断的代码找不到开头。
  //
  // 刻意不用 Home 键：实测它会把光标带到**下一行**（代码行是 white-space: pre，
  // CM 算的视觉行边界跟这里的直觉不一样）。那时长行保持原位是**正确**行为 ——
  // 光标都不在这一行了，凭什么替用户把它滚回去。
  const deep = Math.max(...(await geometry(page)).scrollLefts)

  await jumpTo(page, HEAD)
  const back = await geometry(page)

  // 不断言绝对值：滚动是**够用就停**的（每个编辑器都这样），停在哪个像素取决于
  // 字体度量。要验的是两条真正的性质 ——
  // 显著滚回来了，而且插入符现在落在块内
  expect(Math.max(...back.scrollLefts)).toBeLessThan(deep / 2)
  expect(back.caretX!).toBeGreaterThanOrEqual(back.blockLeft!)
  expect(back.caretX!).toBeLessThanOrEqual(back.blockRight!)
})
