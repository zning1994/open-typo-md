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

test.describe('代码块', () => {
  test('围栏在光标离开后隐藏，进入后显形', async ({ page }) => {
    await resetDoc(page, '前文\n\n```js\nconst a = 1\n```\n\n后文')
    await page.keyboard.press('ControlOrMeta+End')
    expect(await visibleText(page)).not.toContain('```')
    // 语言名改由右上角的选择器呈现，显示的是规范名
    await expect(page.locator('.cm-typo-code-lang')).toHaveValue('JavaScript')

    // 点进代码内容行，围栏应当就地显形，这样用户才删得掉这个块
    await page.locator('.cm-line').filter({ hasText: 'const a = 1' }).first().click()
    expect(await visibleText(page)).toContain('```js')
  })

  test('隐藏围栏后，代码首行仍带代码块样式', async ({ page }) => {
    // 藏行时若把后面那个换行一起盖掉，会和下一行合并、把下一行的行装饰整个丢掉
    await resetDoc(page, '前文\n\n```js\nconst a = 1\n```\n\n后文')
    await page.keyboard.press('ControlOrMeta+End')
    const first = page.locator('.cm-typo-code-first')
    // 用 toContainText 而不是 toHaveText：这一行里还挂着语言选择器，
    // `<option>` 的文本也会算进 textContent 里
    await expect(first).toContainText('const a = 1')
    await expect(first).toHaveClass(/cm-typo-code-block/)
  })

  test('代码不折行，长行产生横向滚动', async ({ page }) => {
    const long = 'const x = ' + '"很长的一行代码".repeat(1) + '.repeat(30) + '1'
    // 前后各垫一段：以围栏开头是退化路径（开围栏不藏）；
    // 结尾也要有内容，否则光标停在文末 == 贴着代码块的闭区间边界 == 算「块内」
    await resetDoc(page, '前文\n\n```js\n' + long + '\n```\n\n后文')

    const codeLine = page.locator('.cm-typo-code-block').first()

    // 用轮询而不是一次性读取：装饰是在语法树就绪后才应用的，
    // 直接断言会跑在它前面，读到的还是「按散文折行」的中间态
    await expect
      .poll(() => codeLine.evaluate((el) => el.scrollWidth > el.clientWidth + 1))
      .toBe(true)

    const whiteSpace = await codeLine.evaluate((el) => getComputedStyle(el).whiteSpace)
    expect(whiteSpace).toBe('pre')

    // 滚动条必须可见 —— 藏掉它等于既不能拖也看不出能滚
    const scrollbar = await codeLine.evaluate((el) => getComputedStyle(el).scrollbarWidth)
    expect(scrollbar).not.toBe('none')
  })

  test('散文仍然折行', async ({ page }) => {
    await resetDoc(page, '这是一段很长的正文。'.repeat(40))
    const line = page.locator('.cm-line').first()

    // 断言行为而不是具体的 white-space 取值 —— CodeMirror 的折行用的是
    // `break-spaces` 而非 `pre-wrap`，两者都折行，写死取值只会测到实现细节
    const overflows = await line.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    expect(overflows).toBe(false)
    expect(await line.evaluate((el) => getComputedStyle(el).whiteSpace)).not.toBe('pre')
  })

  test('同一个代码块内各行的横向滚动保持同步', async ({ page }) => {
    const long = 'x'.repeat(400)
    await resetDoc(
      page,
      '前文\n\n```js\nconst a = "' + long + '"\nconst b = "' + long + '"\n```\n\n后文',
    )

    const lines = page.locator('.cm-typo-code-block')
    await lines.nth(0).evaluate((el) => {
      el.scrollLeft = 120
      el.dispatchEvent(new Event('scroll', { bubbles: false }))
    })

    await expect.poll(() => lines.nth(1).evaluate((el) => el.scrollLeft)).toBe(120)
  })

  test('按语言高亮：js 代码块里出现关键字 token', async ({ page }) => {
    await resetDoc(page, '```js\nconst answer = 42\n```')
    // 语言解析器是异步加载的，加载完才会重新解析出 token
    await expect
      .poll(() => page.locator('.cm-typo-code-block .ͼb, .cm-typo-code-block span').count(), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0)
  })
})

test.describe('代码块语言选择器', () => {
  /** 敲一个代码块，并把光标挪到块外让围栏折叠。 */
  async function writeBlock(
    page: import('@playwright/test').Page,
    info: string,
  ): Promise<void> {
    await resetDoc(page)
    await page.keyboard.type('前文\n\n')
    await page.keyboard.type(`\`\`\`${info}\nconst a = 1\n\`\`\``)
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('后文')
  }

  test('围栏折叠后出现选择器，显示的是规范语言名', async ({ page }) => {
    await writeBlock(page, 'js')
    await expect(page.locator('.cm-typo-code-lang')).toHaveValue('JavaScript')
  })

  test('没标语言时显示纯文本', async ({ page }) => {
    await writeBlock(page, '')
    await expect(page.locator('.cm-typo-code-lang')).toHaveValue('')
  })

  test('选择器和高亮认的是同一套规则 —— py 两边都认', async ({ page }) => {
    // 上游只认名字和别名，py 是扩展名。两套规则分家的表现就是
    // 「下拉框显示纯文本、代码却是彩色的」
    await writeBlock(page, 'py')
    await expect(page.locator('.cm-typo-code-lang')).toHaveValue('Python')
  })

  test('改选语言会写回围栏，源码里是规范名', async ({ page }) => {
    await writeBlock(page, 'js')
    await page.locator('.cm-typo-code-lang').selectOption('Python')

    expect(await docText(page)).toContain('```Python')
    expect(await docText(page)).not.toContain('```js')
  })

  test('改选可以撤销 —— 走的是普通 transaction', async ({ page }) => {
    await writeBlock(page, 'js')
    await page.locator('.cm-typo-code-lang').selectOption('Python')
    expect(await docText(page)).toContain('```Python')

    await page.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+z')
    expect(await docText(page)).toContain('```js')
  })

  test('选成纯文本会清掉语言标注，而不是写个空字符串上去', async ({ page }) => {
    await writeBlock(page, 'js')
    await page.locator('.cm-typo-code-lang').selectOption('')

    expect(await docText(page)).toContain('```\nconst a = 1')
  })

  test('真认不出来的语言原样保留在选项里，不会被悄悄改掉', async ({ page }) => {
    await writeBlock(page, 'zzz-not-a-language')
    await expect(page.locator('.cm-typo-code-lang')).toHaveValue('zzz-not-a-language')
    expect(await docText(page)).toContain('```zzz-not-a-language')
  })

  test('模糊匹配跟高亮保持一致：brainfuck-x 归到 Brainfuck', async ({ page }) => {
    // 上游的规则是「信息串里包含某个长度大于 2 的别名」。这条行为不是我们定的，
    // 但**必须跟高亮一致** —— 所以在这里钉住，将来谁改了匹配规则都会被这条挡下
    await writeBlock(page, 'brainfuck-x')
    await expect(page.locator('.cm-typo-code-lang')).toHaveValue('Brainfuck')
  })

  test('选择器不占行内空间 —— 代码从行首开始', async ({ page }) => {
    await writeBlock(page, 'js')
    const offsets = await page.evaluate(() => {
      const first = document.querySelector('.cm-typo-code-first') as HTMLElement
      const lines = Array.from(document.querySelectorAll('.cm-typo-code-block'))
      return lines
        .map((l) => Math.round(l.getBoundingClientRect().left))
        .concat(Math.round(first.getBoundingClientRect().left))
    })
    // 所有代码行左边界一致 —— 首行没有被选择器顶右
    expect(new Set(offsets).size).toBe(1)
  })

  test('光标进入代码块时选择器消失（此时围栏本身可见）', async ({ page }) => {
    await writeBlock(page, 'js')
    await expect(page.locator('.cm-typo-code-lang')).toHaveCount(1)

    await page.getByText('const a = 1').click()
    await expect(page.locator('.cm-typo-code-lang')).toHaveCount(0)
  })
})
