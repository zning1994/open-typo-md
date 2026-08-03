/**
 * 长文里「点哪儿、光标落哪儿」的一致性（issue #34）。
 *
 * 必须是 E2E：这条断言的两端都由**真实布局**决定 —— 一端是行在屏幕上的
 * 矩形，另一端是 CodeMirror 把屏幕坐标翻译成的文档位置。单测里没有布局，
 * 两端量出来都是 0，怎么写都是绿的。
 *
 * 根因不在鼠标事件，在**高度表**：`posAtCoords` 先用 `elementAtHeight(y)`
 * 从高度表里找行，而高度表的每行高度来自 `getBoundingClientRect().height`
 * —— 那个数**不含 margin**。所以只要给 `.cm-line` 设了纵向 margin
 * （标题、代码块的上下留白），行在 DOM 里占的位置就比高度表以为的靠下，
 * 差值沿着视口从上往下累加，点击就落到下面一两行去了。
 *
 * 因此用例里的文档**必须密集地夹带标题和代码块** —— 换成纯段落长文，
 * 这一组会恒绿而且什么都没验到。
 */
import { ACTIVE_CONTENT, expect, test } from './fixtures.js'
import type { Page } from '@playwright/test'

const SECTIONS = 60

/** 每行都带唯一标记，这样「点到的行」和「字落进的行」可以逐字比对。 */
function longDoc(): string {
  const out: string[] = []
  for (let s = 1; s <= SECTIONS; s++) {
    out.push(`## SEC-${s} 小节标题`)
    out.push('')
    for (const tag of ['A', 'B', 'C']) out.push(`SEC-${s} / LINE-${tag} 正文内容。`)
    out.push('')
    out.push('```js')
    out.push(`const sec${s} = ${s};`)
    out.push('```')
    out.push('')
  }
  return out.join('\n')
}

async function paste(page: Page, text: string): Promise<void> {
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.evaluate((doc) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', doc)
    document
      .querySelector('.tab-page:not([hidden]) .cm-content')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
  }, text)
  await page.waitForTimeout(400)
}

async function scrollTo(page: Page, where: 'bottom' | 'middle' | 'top'): Promise<void> {
  await page.evaluate((target) => {
    const scroller = document.querySelector(
      '.tab-page:not([hidden]) .cm-scroller',
    ) as HTMLElement
    scroller.scrollTop =
      target === 'top'
        ? 0
        : target === 'middle'
          ? scroller.scrollHeight / 2
          : scroller.scrollHeight
  }, where)
  await page.waitForTimeout(500)
}

const LINE_ID = /SEC-\d+ \/ LINE-[ABC]/

/**
 * 点视口下沿附近的一行正文，敲一个标记，返回「点中的行」和「标记落进的行」。
 *
 * 偏移是沿着视口从上往下累加的，越靠下越明显 —— 所以下沿附近才是这个缺陷
 * 最容易现形的地方，别改成点视口中间。
 */
async function clickLowestLineAndType(page: Page, marker: string) {
  const target = await page.evaluate(() => {
    const root = document.querySelector('.tab-page:not([hidden])') as HTMLElement
    const scroller = root.querySelector('.cm-scroller') as HTMLElement
    const box = scroller.getBoundingClientRect()
    const lines = ([...root.querySelectorAll('.cm-line')] as HTMLElement[])
      .map((el) => ({ rect: el.getBoundingClientRect(), text: el.textContent ?? '' }))
      // 只挑 `LINE-x` 那种正文行。标题行的上下留白算它自己的一部分，
      // 点在留白上落到哪一行取决于取整，那不是这条用例要说的事
      .filter((l) => / \/ LINE-/.test(l.text))
      .filter((l) => l.rect.top >= box.top + 8 && l.rect.bottom <= box.bottom - 8)

    const picked = lines.at(-1)
    if (!picked) throw new Error('视口里没有可点的正文行')
    return {
      text: picked.text,
      x: Math.round(picked.rect.left + 6),
      y: Math.round(picked.rect.top + picked.rect.height / 2),
    }
  })

  await page.mouse.click(target.x, target.y)
  await page.keyboard.type(marker)
  await page.waitForTimeout(300)

  // 直接读实时预览下的 DOM：敲进去的是纯文本，装饰不会改写它。
  // 不走 `docText()` —— 那个要切源码模式，而它只读得到视口内的行，
  // 几百行的文档切一次模式就可能把目标行滚出渲染范围
  const landed = await page.evaluate(
    (mark) =>
      (
        [...document.querySelectorAll('.tab-page:not([hidden]) .cm-line')] as HTMLElement[]
      ).find((el) => el.textContent?.includes(mark))?.textContent ?? '',
    marker,
  )

  return { clicked: target.text, landed }
}

function expectSameLine(clicked: string, landed: string, marker: string): void {
  const id = LINE_ID.exec(clicked)?.[0]
  expect(id, `点中的行没有标记：${clicked}`).toBeTruthy()

  // 敲进去的标记落在行首那个字的**后面**（点击 x 取的是首字中部），
  // 于是它会把 `SEC-35` 切成 `S` + `EC-35`。先把标记摘掉再比 ——
  // 不摘的话这条断言即使定位完全正确也会红，那就是在测我自己的字符串拼接
  const cleaned = landed.replace(marker, '')
  expect(cleaned, `点的是「${id}」，字却落进了「${landed}」`).toContain(id as string)
}

test.describe('长文的点击定位（#34）', () => {
  test('滚到底部后，点击命中的行就是字落进去的行', async ({ page }) => {
    await paste(page, longDoc())
    await scrollTo(page, 'bottom')

    const { clicked, landed } = await clickLowestLineAndType(page, 'BOTTOMCLICK')
    expectSameLine(clicked, landed, 'BOTTOMCLICK')
  })

  test('滚到中间后，点击命中的行就是字落进去的行', async ({ page }) => {
    await paste(page, longDoc())
    await scrollTo(page, 'middle')

    const { clicked, landed } = await clickLowestLineAndType(page, 'MIDCLICK')
    expectSameLine(clicked, landed, 'MIDCLICK')
  })

  test('相邻的行首尾相接，中间没有高度表看不见的空间', async ({ page }) => {
    await paste(page, longDoc())
    await scrollTo(page, 'middle')

    // 上面两条测的是用户看得见的后果，这一条钉的是成因。
    //
    // 留着它是因为后果那两条对「差多少像素」不敏感：偏移小于半行高时它们
    // 照样是绿的，而下一个人给标题加一点 margin 恰好就落在那个区间里。
    //
    // 断言的形式刻意不是「margin 为零」而是「两行之间没有缝」：真正的不变量
    // 是「行占的纵向空间必须全部落在它自己的边框盒里」，margin 只是眼下唯一
    // 违反它的写法。缝隙这个说法对将来别的写法一样成立。
    const gaps = await page.evaluate(() => {
      const lines = [
        ...document.querySelectorAll('.tab-page:not([hidden]) .cm-line'),
      ] as HTMLElement[]
      const bad: { after: string; gap: number }[] = []
      for (const el of lines) {
        // 只比相邻的两个 `.cm-line`。中间隔着块级 widget 或视口占位块时
        // 本来就该有间距，那不是这条不变量说的事
        const next = el.nextElementSibling as HTMLElement | null
        if (!next?.classList.contains('cm-line')) continue
        const gap = next.getBoundingClientRect().top - el.getBoundingClientRect().bottom
        // 亚像素舍入给 1px
        if (Math.abs(gap) > 1) bad.push({ after: el.className, gap: Math.round(gap) })
      }
      // 同一种行有几十个，报一次就够了
      return bad.filter((m, i, all) => all.findIndex((o) => o.after === m.after) === i)
    })

    expect(gaps).toEqual([])
  })
})
