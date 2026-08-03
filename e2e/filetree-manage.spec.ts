/**
 * 文件树作为工作区入口：标题、右键菜单、新建 / 重命名 / 移到废纸篓、
 * 过滤与排序（issue #36）。
 *
 * 原生菜单弹出来之后测不了（`Menu.popup` 是系统菜单，Playwright 够不着，
 * 而且它阻塞到用户选中），所以这里沿用 `context-menu.spec.ts` 的姿势：
 * 顶掉 `Menu.prototype.popup`，记下菜单形状并直接选中某一项。
 * 替身的是**系统那一层** —— 从渲染进程算上下文、到 main 建模板、
 * 到选中之后真正动磁盘，产品代码一行都没绕开。
 *
 * 断言尽量落在**磁盘上**而不是 DOM 上：文件树画对了但文件没建出来，
 * 是这一批最可能的坏法。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clickMenu, docText, expect, stubOpenDialog, test } from './fixtures.js'
import type { ElectronApplication, Page } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mosu-tree-mgmt-'))
  // 有标题的、没标题的、front matter 挡在前面的 —— 三种都要在树上显示正确
  await writeFile(path.join(dir, 'a-notes.md'), '# 项目笔记\n\n正文。\n', 'utf8')
  await writeFile(path.join(dir, 'b-plain.md'), '没有标题的一份文档。\n', 'utf8')
  await writeFile(
    path.join(dir, 'c-meta.md'),
    '---\ntitle: 元数据\n---\n\n# 真正的标题\n',
    'utf8',
  )
  await mkdir(path.join(dir, '子目录'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

async function openFolder(app: ElectronApplication, page: Page): Promise<void> {
  await stubOpenDialog(app, [dir])
  await clickMenu(app, ['文件', '打开文件夹…'])
  await expect(page.locator('.mosu-files')).toBeVisible()
}

const items = (page: Page) => page.locator('.mosu-files__item')

/** 顶掉原生菜单，记下形状；`pick` 给了就顺手选中那一项。 */
async function stubPopup(app: ElectronApplication, pick: string | null): Promise<void> {
  await app.evaluate(({ Menu }, label) => {
    const store = globalThis as unknown as { __menus: unknown[] }
    store.__menus = []
    ;(Menu.prototype as unknown as { popup: (options?: unknown) => void }).popup = function (
      this: { items: { label: string; enabled: boolean; click?: () => void }[] },
      options?: { callback?: () => void },
    ) {
      // 分隔符也在 items 里，label 是空串。滤掉 —— 这一组关心的是
      // 「有哪几项」，分隔符的位置由单测（context-menu.test.ts）盯着
      store.__menus.push(this.items.map((item) => item.label).filter(Boolean))
      if (label) this.items.find((item) => item.label === label)?.click?.()
      options?.callback?.()
    }
  }, pick)
}

async function lastMenu(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const store = globalThis as unknown as { __menus: string[][] }
    return store.__menus[store.__menus.length - 1] ?? []
  })
}

/** 顶掉确认对话框，让它直接返回某个按钮。 */
async function stubConfirm(app: ElectronApplication, buttonIndex: number): Promise<void> {
  await app.evaluate(({ dialog }, index) => {
    dialog.showMessageBox = async () => ({ response: index, checkboxChecked: false })
  }, buttonIndex)
}

async function rightClickItem(page: Page, text: string): Promise<void> {
  await items(page).filter({ hasText: text }).first().click({ button: 'right' })
  await page.waitForTimeout(250)
}

test.describe('文件树显示文档标题', () => {
  test('有标题就显示标题，文件名退成副标签', async ({ app, page }) => {
    await openFolder(app, page)

    const row = items(page).filter({ hasText: '项目笔记' })
    await expect(row).toHaveCount(1)
    // 文件名没有消失 —— 两份文档同名标题时它是唯一的区分手段
    await expect(row.locator('.mosu-files__sub')).toHaveText('a-notes.md')
  })

  test('没有标题就显示文件名，也不留一个空的副标签', async ({ app, page }) => {
    await openFolder(app, page)

    const row = items(page).filter({ hasText: 'b-plain.md' })
    await expect(row).toHaveCount(1)
    // 主标签已经是文件名时，副标签就是纯噪声
    await expect(row.locator('.mosu-files__sub')).toHaveCount(0)
  })

  test('front matter 里的 title 不是标题', async ({ app, page }) => {
    await openFolder(app, page)

    await expect(items(page).filter({ hasText: '真正的标题' })).toHaveCount(1)
    await expect(items(page).filter({ hasText: '元数据' })).toHaveCount(0)
  })
})

test.describe('右键菜单', () => {
  test('文件上有打开 / 新标签页打开 / 重命名 / 移到废纸篓', async ({ app, page }) => {
    await openFolder(app, page)
    await stubPopup(app, null)
    await rightClickItem(page, '项目笔记')

    expect(await lastMenu(app)).toEqual([
      '打开',
      '在新标签页打开',
      '重命名…',
      '移到废纸篓',
      '复制文件路径',
      '在文件夹中显示',
    ])
  })

  test('文件夹上是新建那一组', async ({ app, page }) => {
    await openFolder(app, page)
    await stubPopup(app, null)
    await rightClickItem(page, '子目录')

    const labels = await lastMenu(app)
    expect(labels).toContain('新建 Markdown 文件…')
    expect(labels).toContain('新建文件夹…')
    expect(labels).not.toContain('打开')
  })

  test('在新标签页打开：当前空白标签不会被顶掉', async ({ app, page }) => {
    await openFolder(app, page)
    await stubPopup(app, '在新标签页打开')
    await rightClickItem(page, '项目笔记')

    await expect.poll(() => docText(page)).toContain('项目笔记')
    // 空白标签 + 新开的这个 = 2
    await expect(page.locator('.tab')).toHaveCount(2)
  })
})

test.describe('新建', () => {
  test('新建 Markdown 文件：落到磁盘上，并且自动补 .md', async ({ app, page }) => {
    await openFolder(app, page)
    await stubPopup(app, '新建 Markdown 文件…')
    await rightClickItem(page, '子目录')

    const input = page.locator('.mosu-files__input')
    await expect(input).toBeVisible()
    // 不带扩展名 —— 产品应当补 .md
    await input.fill('周报')
    await input.press('Enter')

    await expect
      .poll(() => readdir(path.join(dir, '子目录')), { timeout: 5_000 })
      .toEqual(['周报.md'])
  })

  test('Esc 取消，磁盘上什么都没变', async ({ app, page }) => {
    await openFolder(app, page)
    await stubPopup(app, '新建 Markdown 文件…')
    await rightClickItem(page, '子目录')

    const input = page.locator('.mosu-files__input')
    await input.fill('不该出现')
    await input.press('Escape')

    await expect(input).toHaveCount(0)
    expect(await readdir(path.join(dir, '子目录'))).toEqual([])
  })

  test('新建文件夹', async ({ app, page }) => {
    await openFolder(app, page)
    await stubPopup(app, '新建文件夹…')
    await rightClickItem(page, '子目录')

    await page.locator('.mosu-files__input').fill('更深一层')
    await page.locator('.mosu-files__input').press('Enter')

    await expect
      .poll(() => readdir(path.join(dir, '子目录')), { timeout: 5_000 })
      .toEqual(['更深一层'])
  })
})

test.describe('重命名', () => {
  test('改得动，内容一个字节没变', async ({ app, page }) => {
    await openFolder(app, page)
    await stubPopup(app, '重命名…')
    await rightClickItem(page, 'b-plain.md')

    await page.locator('.mosu-files__input').fill('renamed.md')
    await page.locator('.mosu-files__input').press('Enter')

    await expect
      .poll(() => readFile(path.join(dir, 'renamed.md'), 'utf8'), { timeout: 5_000 })
      .toBe('没有标题的一份文档。\n')
  })

  test('改名不会覆盖已有的文件', async ({ app, page }) => {
    await openFolder(app, page)
    await stubPopup(app, '重命名…')
    await rightClickItem(page, 'b-plain.md')

    // 改成一个已经存在的名字。`fs.rename` 默认会静默覆盖 —— 少了那道检查，
    // 用户丢的是一份自己都不知道存在的文档
    await page.locator('.mosu-files__input').fill('a-notes.md')
    await page.locator('.mosu-files__input').press('Enter')
    await page.waitForTimeout(600)

    expect(await readFile(path.join(dir, 'a-notes.md'), 'utf8')).toBe('# 项目笔记\n\n正文。\n')
    expect(await readFile(path.join(dir, 'b-plain.md'), 'utf8')).toBe('没有标题的一份文档。\n')
  })

  test('开着的标签跟着换路径，未保存的修改还在', async ({ app, page }) => {
    await openFolder(app, page)
    await items(page).filter({ hasText: 'b-plain.md' }).click()
    await expect.poll(() => docText(page)).toContain('没有标题')

    // 敲一点没保存的东西 —— 改名绝不该把它冲掉
    await page.locator('.tab-page:not([hidden]) .cm-content').click()
    await page.keyboard.type('未保存的补充。')

    await stubPopup(app, '重命名…')
    await rightClickItem(page, 'b-plain.md')
    await page.locator('.mosu-files__input').fill('moved.md')
    await page.locator('.mosu-files__input').press('Enter')
    await page.waitForTimeout(800)

    // 缓冲区没有被重新读盘冲掉
    expect(await docText(page)).toContain('未保存的补充。')
    // 保存之后落在**新**名字上，磁盘上不会凭空多出一份旧文件
    await clickMenu(app, ['文件', '保存'])
    await expect
      .poll(() => readFile(path.join(dir, 'moved.md'), 'utf8'), { timeout: 5_000 })
      .toContain('未保存的补充。')
    expect(await readdir(dir)).not.toContain('b-plain.md')
  })
})

test.describe('移到废纸篓', () => {
  test('确认之后文件从磁盘上消失，树里也不见了', async ({ app, page }) => {
    await openFolder(app, page)
    await stubConfirm(app, 0) // 0 = 移到废纸篓
    await stubPopup(app, '移到废纸篓')
    await rightClickItem(page, '项目笔记')

    await expect.poll(() => readdir(dir), { timeout: 8_000 }).not.toContain('a-notes.md')
    await expect(items(page).filter({ hasText: '项目笔记' })).toHaveCount(0)
  })

  test('取消就什么都不做', async ({ app, page }) => {
    await openFolder(app, page)
    await stubConfirm(app, 1) // 1 = 取消
    await stubPopup(app, '移到废纸篓')
    await rightClickItem(page, '项目笔记')
    await page.waitForTimeout(600)

    expect(await readdir(dir)).toContain('a-notes.md')
  })
})

test.describe('过滤与排序', () => {
  test('过滤只留下匹配的文件，目录仍在', async ({ app, page }) => {
    await openFolder(app, page)
    await page.locator('.mosu-files__filter').fill('notes')

    await expect(items(page).filter({ hasText: '项目笔记' })).toHaveCount(1)
    await expect(items(page).filter({ hasText: 'b-plain.md' })).toHaveCount(0)
    // 目录一律保留：藏掉的话深处的匹配项会连同它的路径一起消失
    await expect(items(page).filter({ hasText: '子目录' })).toHaveCount(1)
  })

  test('按标题也能过滤到 —— 树上显示的就是标题', async ({ app, page }) => {
    await openFolder(app, page)
    // 「项目笔记」这四个字在文件名 a-notes.md 里一个都没有
    await page.locator('.mosu-files__filter').fill('项目笔记')

    await expect(items(page).filter({ hasText: '项目笔记' })).toHaveCount(1)
    await expect(items(page).filter({ hasText: '真正的标题' })).toHaveCount(0)
  })

  test('按修改时间排序时最新的在前，目录仍然排在文件之前', async ({ app, page }) => {
    // 把 b-plain 改成最新的一个
    await writeFile(path.join(dir, 'b-plain.md'), '没有标题的一份文档。\n', 'utf8')
    await openFolder(app, page)
    await page.locator('.mosu-files__sort').click()
    await page.waitForTimeout(400)

    const labels = await items(page).allTextContents()
    expect(labels[0]).toContain('子目录')
    // 目录之后第一个应当是刚写过的那份
    expect(labels[1]).toContain('b-plain.md')
  })
})
