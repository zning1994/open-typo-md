/**
 * 大纲面板与命令面板。
 *
 * 这两个是外壳里第一批真正的交互 UI。放 e2e 的理由跟输入行为一样：
 * 它们的价值全在焦点、键盘导航、以及「关掉之后还能不能接着打字」上，
 * 而这三样在 jsdom 里测出来的结论跟真实浏览器未必一致。
 */
import { expect, resetDoc, test } from './fixtures.js'
import type { ElectronApplication } from '@playwright/test'

const DOC = ['# 第一章', '', '正文一', '', '## 一点一', '', '正文二', '', '# 第二章', ''].join(
  '\n',
)

/**
 * 点一次真实的原生菜单项。
 *
 * 不用键盘加速键：xvfb 下没有窗口管理器，原生焦点建立不起来，加速键根本不触发。
 * 也不给测试开后门 —— 这里点的就是用户点的那个菜单项，
 * 走的是同一条 `webContents.send(menuCommand)`。
 */
async function menu(app: ElectronApplication, path: string[]): Promise<void> {
  await app.evaluate(({ Menu }, labels) => {
    let items = Menu.getApplicationMenu()?.items ?? []
    let target: (typeof items)[number] | undefined
    for (const label of labels) {
      target = items.find((item) => item.label === label)
      if (!target) throw new Error(`菜单里找不到「${label}」`)
      items = target.submenu?.items ?? []
    }
    target?.click()
  }, path)
}

const OUTLINE = ['视图', '大纲']
const PALETTE = ['视图', '命令面板']

/**
 * 打开命令面板并**等它拿到焦点**再返回。
 *
 * 菜单命令是走 IPC 过来的，面板的出现相对于测试代码是异步的。
 * 不等就直接敲键盘的话，按键会落进编辑器 —— 而当时正好是全选状态，
 * 于是输入把选中的正文替换掉了，用例以一种完全看不出原因的方式失败。
 */
async function openPalette(
  app: ElectronApplication,
  page: import('@playwright/test').Page,
): Promise<void> {
  await menu(app, PALETTE)
  await expect(page.locator('.mosu-palette__input')).toBeFocused()
}

test.describe('大纲面板', () => {
  test('打开后列出全部标题，层级体现在类名上', async ({ app, page }) => {
    await resetDoc(page, DOC)
    await menu(app, OUTLINE)

    const links = page.locator('.mosu-outline__link')
    await expect(links).toHaveCount(3)
    await expect(links.nth(0)).toHaveText('第一章')
    await expect(links.nth(1)).toHaveText('一点一')
    await expect(links.nth(2)).toHaveText('第二章')

    await expect(page.locator('.mosu-outline__item').nth(0)).toHaveClass(/--h1/)
    await expect(page.locator('.mosu-outline__item').nth(1)).toHaveClass(/--h2/)
  })

  test('点标题跳过去，焦点回到编辑器', async ({ app, page }) => {
    await resetDoc(page, DOC)
    await menu(app, OUTLINE)

    await page.locator('.mosu-outline__link').nth(2).click()
    // 焦点确实回来了：直接打字就能进文档
    await page.keyboard.type('X')

    // 状态栏是 200ms 防抖的，得等它
    await expect(page.locator('#status-stats')).toContainText('9:') // 第二章那一行
  })

  test('高亮跟着光标走', async ({ app, page }) => {
    await resetDoc(page, DOC)
    await menu(app, OUTLINE)

    await page.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+End')
    await expect(page.locator('.mosu-outline__item.is-active')).toHaveCount(1)
    await expect(page.locator('.mosu-outline__item.is-active .mosu-outline__link')).toHaveText(
      '第二章',
    )
  })

  test('没有标题时给出说明而不是一片空白', async ({ app, page }) => {
    await resetDoc(page, '只有正文，没有任何标题')
    await menu(app, OUTLINE)

    await expect(page.locator('.mosu-outline__empty')).toHaveText('这篇文档还没有标题')
  })

  test('再切一次就收起来', async ({ app, page }) => {
    await resetDoc(page, DOC)
    await menu(app, OUTLINE)
    await expect(page.locator('.mosu-outline')).toBeVisible()

    await menu(app, OUTLINE)
    await expect(page.locator('.mosu-outline')).toBeHidden()
  })
})

test.describe('命令面板', () => {
  test('打开后输入框自动获得焦点', async ({ app, page }) => {
    await resetDoc(page, '正文')
    await menu(app, PALETTE)

    await expect(page.locator('.mosu-palette__input')).toBeFocused()
  })

  test('模糊搜索，命中的字符高亮', async ({ app, page }) => {
    await resetDoc(page, '正文')
    await openPalette(app, page)
    await page.keyboard.type('加粗')

    const items = page.locator('.mosu-palette__item')
    await expect(items.first()).toContainText('加粗')
    // 相邻的命中会合并成一个 <mark>，所以是一个元素、两个字
    await expect(items.first().locator('mark')).toHaveText('加粗')
  })

  test('Enter 执行选中的命令', async ({ app, page }) => {
    await resetDoc(page, '重点')
    await page.keyboard.press('ControlOrMeta+a')

    await openPalette(app, page)
    await page.keyboard.type('加粗')
    await page.keyboard.press('Enter')

    await expect(page.locator('.cm-mosu-strong')).toHaveCount(1)
  })

  test('上下键在列表里循环', async ({ app, page }) => {
    await resetDoc(page, '正文')
    await openPalette(app, page)

    // 从第一项往上走一格应当回到最后一项
    await page.keyboard.press('ArrowUp')
    const items = page.locator('.mosu-palette__item')
    const count = await items.count()
    await expect(items.nth(count - 1)).toHaveClass(/is-active/)
  })

  test('Esc 关闭，焦点回到编辑器', async ({ app, page }) => {
    await resetDoc(page, '正文')
    await openPalette(app, page)
    await page.keyboard.press('Escape')

    await expect(page.locator('.mosu-palette')).toBeHidden()
    // 焦点还回来了才算真的关干净 —— 否则下一次按键石沉大海
    await page.keyboard.type('继续写')
    await expect(page.locator('.cm-content')).toContainText('继续写')
  })

  test('点遮罩也能关', async ({ app, page }) => {
    await resetDoc(page, '正文')
    await openPalette(app, page)

    await page.locator('.mosu-palette').click({ position: { x: 5, y: 5 } })
    await expect(page.locator('.mosu-palette')).toBeHidden()
  })

  test('搜不到时给出说明', async ({ app, page }) => {
    await resetDoc(page, '正文')
    await openPalette(app, page)
    await page.keyboard.type('zzzzzz')

    await expect(page.locator('.mosu-palette__empty')).toHaveText('没有匹配的命令')
  })

  test('面板里列出的命令跟菜单是同一份 —— 大纲开关也能搜到', async ({ app, page }) => {
    await resetDoc(page, '正文')
    await openPalette(app, page)
    await page.keyboard.type('大纲')

    await expect(page.locator('.mosu-palette__item').first()).toContainText('大纲')
  })

  /**
   * 换了一篇文档就该收掉（issue #3）。
   *
   * 命令面板是**瞬时**浮层：过滤文字和候选项都是冲着刚才那篇文档去的。
   * 留在屏幕上的话，用户面对的是新文档，而浮层里列的是旧文档的命令 ——
   * 而且接下来的每一次按键都打进过滤框，不是打进文档。
   */
  test('打开另一篇文档时自动收起，不会浮在新文档上面', async ({ app, page }) => {
    await resetDoc(page, '正文')
    await openPalette(app, page)
    await page.keyboard.type('表格')
    await expect(page.locator('.mosu-palette')).toBeVisible()

    await menu(app, ['文件', '新建标签页'])
    await expect(page.locator('.mosu-palette')).toBeHidden()

    // 焦点也该在新文档里 —— 不然「关掉了」只是看不见而已
    await page.keyboard.type('新文档的内容')
    await expect(page.locator('.tab-page:not([hidden]) .cm-content')).toContainText(
      '新文档的内容',
    )

    await resetDoc(page)
    await menu(app, ['文件', '关闭标签页'])
  })

  test('切回原来的标签同样收起', async ({ app, page }) => {
    await resetDoc(page, '正文')
    await menu(app, ['文件', '新建标签页'])
    await openPalette(app, page)
    await expect(page.locator('.mosu-palette')).toBeVisible()

    await menu(app, ['文件', '关闭标签页'])
    await expect(page.locator('.mosu-palette')).toBeHidden()
  })
})
