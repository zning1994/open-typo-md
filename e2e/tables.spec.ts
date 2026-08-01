/**
 * 表格在真实浏览器里的呈现与可编辑性。
 *
 * 这些断言**单元测试做不了**：表格的呈现方案（CSS 匿名表格盒，见
 * live-preview/tables.ts）押的是一个纯布局行为 —— 给 `.cm-line` 挂
 * `display: table-row`，让浏览器自动把连续的行包成一张表。
 *
 * 押注就得验：
 *
 * 1. 匿名表格盒真的形成了吗（列宽跨行对齐）？
 * 2. CodeMirror 的坐标映射还准吗（点哪儿，光标就落在哪儿）？
 * 3. 还能正常打字吗（contenteditable 在 table-row 里不出怪事）？
 *
 * 第 2、3 条是这套方案唯一的真风险。任何一条不过，就该退回
 * `display: flex` + `flex: 1 1 0` 的等宽列方案 —— 装饰结构完全一样，
 * 只需要改 theme.ts 里的两条 CSS。
 */
import { docText, expect, resetDoc, test, visibleText } from './fixtures.js'

const TABLE = ['| 姓名 | 城市 |', '| --- | ---: |', '| 张三 | 北京 |', '| 李四 | 上海 |'].join(
  '\n',
)

/**
 * 敲出表格并**等装饰真正落地**再返回。
 *
 * 最后那次等待不是保险起见：装饰是在语法树就绪之后才应用的，
 * 敲完立刻断言会跑在它前面 —— 机器空闲时侥幸能过，一忙就翻。
 * 表头 + 两行数据 = 3 个表格行，分隔行此时应当已经藏起来。
 */
async function typeTable(page: import('@playwright/test').Page): Promise<void> {
  await resetDoc(page)
  await page.keyboard.type(TABLE)
  // 把光标挪出表格，让分隔行藏起来、竖线折叠
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('表格后面的段落')

  await expect(page.locator('.cm-typo-tr')).toHaveCount(3)
}

test('分隔行藏起来，竖线折叠', async ({ page }) => {
  await typeTable(page)
  const shown = await visibleText(page)
  expect(shown).not.toContain('---')
  expect(shown).not.toContain('|')
  expect(shown).toContain('张三')
})

test('源码一个字节都没变', async ({ page }) => {
  await typeTable(page)
  expect(await docText(page)).toBe(`${TABLE}\n\n表格后面的段落`)
})

test('连续的表格行形成一张表：同列的左边界跨行对齐', async ({ page }) => {
  await typeTable(page)

  const columnLefts = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.cm-typo-tr'))
    return rows.map((row) =>
      Array.from(row.querySelectorAll('.cm-typo-td')).map((cell) =>
        Math.round(cell.getBoundingClientRect().left),
      ),
    )
  })

  expect(columnLefts.length).toBe(3) // 表头 + 两行数据；分隔行是藏起来的
  const [head, first, second] = columnLefts as number[][]
  expect(head).toHaveLength(2)

  // 容差 1px：亚像素布局下同一列的边界会差个零点几像素，取整后就是 ±1。
  // 匿名表格盒没形成的话各行按自身内容宽度排布，差的是几十像素，不会被这条容差放过。
  for (const row of [first, second] as number[][]) {
    expect(row).toHaveLength(head!.length)
    row.forEach((left, i) => expect(Math.abs(left - head![i]!)).toBeLessThanOrEqual(1))
  }
})

test('中间夹一行普通段落会断成两张表', async ({ page }) => {
  // 这是匿名表格盒的语义，也正是我们想要的：不需要额外打标记
  await resetDoc(page)
  await page.keyboard.type('| 很长很长的表头 | b |\n| --- | --- |\n| 1 | 2 |\n')
  await page.keyboard.type('\n中间的段落\n\n')
  await page.keyboard.type('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
  await page.keyboard.press('Enter')
  await page.keyboard.type('结尾')

  // 同 typeTable：等装饰落地再量尺寸。两张表各 2 行 = 4 个表格行
  await expect(page.locator('.cm-typo-tr')).toHaveCount(4)

  const widths = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-typo-tr')).map((row) =>
      Math.round(
        (row.querySelector('.cm-typo-td') as HTMLElement).getBoundingClientRect().width,
      ),
    ),
  )
  // 两张表各自算列宽：第一张的首列明显更宽
  expect(widths[0]).toBeGreaterThan(widths[widths.length - 1]!)
})

test('点击单元格，光标落在被点的那个字上', async ({ page }) => {
  // 坐标映射是这套方案的头号风险：table-row 会不会让 posAtCoords 算歪
  await typeTable(page)

  const target = page.locator('.cm-typo-tr').nth(2).locator('.cm-typo-td').nth(1)
  const box = (await target.boundingBox())!
  // 点在这一格靠左的位置（右对齐列，内容贴右，所以取内容起点附近）
  await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2)

  await page.keyboard.type('X')
  // 光标确实落在「上海」这一格里，而不是别的格、别的行
  expect(await docText(page)).toContain('上海')
  expect(await docText(page)).toMatch(/\|\s*[^|]*X[^|]*\|\s*$/m)
})

test('在单元格里打字，表格结构不散', async ({ page }) => {
  await typeTable(page)

  const cell = page.locator('.cm-typo-tr').nth(1).locator('.cm-typo-td').first()
  await cell.click()
  await page.keyboard.type('新')

  const text = await docText(page)
  expect(text).toContain('新')
  // 行数没变，说明没有意外插入换行
  expect(text.split('\n')).toHaveLength(TABLE.split('\n').length + 2)
})

test('光标进入表格时竖线与分隔行一起显形', async ({ page }) => {
  await typeTable(page)
  await page.locator('.cm-typo-tr').nth(1).locator('.cm-typo-td').first().click()

  const shown = await visibleText(page)
  expect(shown).toContain('|')
  expect(shown).toContain('---')
})

test('显形之后列结构不变 —— 竖线是长在单元格里的', async ({ page }) => {
  // 竖线若落在两个 table-cell 之间，浏览器会给它生成匿名单元格，
  // 列数凭空多出来、整张表当场重排。这条用例就是盯着这个。
  await typeTable(page)

  const columnsWhenFolded = await page.evaluate(
    () => document.querySelectorAll('.cm-typo-tr')[0]!.querySelectorAll('.cm-typo-td').length,
  )

  await page.locator('.cm-typo-tr').nth(1).locator('.cm-typo-td').first().click()

  const columnsWhenRevealed = await page.evaluate(
    () => document.querySelectorAll('.cm-typo-tr')[0]!.querySelectorAll('.cm-typo-td').length,
  )

  expect(columnsWhenRevealed).toBe(columnsWhenFolded)
})

test('右对齐列真的右对齐', async ({ page }) => {
  await typeTable(page)
  const align = await page.evaluate(() => {
    const cell = document
      .querySelectorAll('.cm-typo-tr')[1]!
      .querySelectorAll('.cm-typo-td')[1] as HTMLElement
    return getComputedStyle(cell).textAlign
  })
  expect(align).toBe('right')
})

test('表格内容不折行', async ({ page }) => {
  await resetDoc(page)
  await page.keyboard.type('| 列 |\n| --- |\n')
  await page.keyboard.type(`| ${'很长的内容'.repeat(30)} |`)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('结尾')

  await expect(page.locator('.cm-typo-tr')).toHaveCount(2)

  const measured = await page.evaluate(() => {
    const rows = document.querySelectorAll('.cm-typo-tr')
    const row = rows[rows.length - 1] as HTMLElement
    return {
      whiteSpace: getComputedStyle(row).whiteSpace,
      // 不折行的直接证据：单元格比可视宽度宽得多，而不是被压成多行
      cellWidth: (row.querySelector('.cm-typo-td') as HTMLElement).getBoundingClientRect()
        .width,
      lineHeight: row.getBoundingClientRect().height,
    }
  })
  expect(measured.whiteSpace).toBe('pre')
  expect(measured.cellWidth).toBeGreaterThan(1000)
  // 折了行的话这一行会有几十上百像素高
  expect(measured.lineHeight).toBeLessThan(60)
})
