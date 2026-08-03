import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  _electron as electron,
  test as base,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

const appRoot = fileURLToPath(new URL('../apps/desktop', import.meta.url))

export interface MosuFixtures {
  app: ElectronApplication
  page: Page
  /** 每个用例独立的用户数据目录，避免设置互相污染。 */
  userDataDir: string
}

export const test = base.extend<MosuFixtures>({
  // eslint-disable-next-line no-empty-pattern
  userDataDir: async ({}, use) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mosu-e2e-'))

    // 把界面语言**钉死**在简体中文。
    //
    // 不钉的话菜单标签取决于 `app.getLocale()`，也就是取决于**跑测试的那台
    // 机器的系统区域** —— 三个平台的 CI runner 各给各的，本地开发机又是另一个。
    // 用例里那五十来处 `clickMenu(app, ['视图', …])` 会在某些机器上莫名找不到
    // 菜单项，而失败信息只会说「菜单里找不到」，看不出是区域的问题。
    //
    // 换语言本身由 writing-modes 之外的一条专门用例覆盖（i18n.spec.ts）。
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ 'ui.language': 'zh-CN' }))

    await use(dir)

    // Electron 退出时还在往 userData 目录里写东西，紧接着删就会撞上
    // ENOTEMPTY（macOS 上尤其容易）。maxRetries 正是为这类错误准备的。
    //
    // 而且临时目录清理失败**不该让用例挂掉** —— 它不是任何一条产品断言。
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => undefined,
    )
  },

  app: async ({ userDataDir }, use) => {
    const app = await electron.launch({
      args: [
        appRoot,
        `--user-data-dir=${userDataDir}`,
        // CI 容器里没有 SUID sandbox helper，且这只影响 Chromium 的进程沙箱，
        // 不影响我们自己的 contextIsolation / nodeIntegration 配置
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ],
      env: { ...process.env, NODE_ENV: 'test' },
    })
    await use(app)

    // 显式退出整个应用进程，而不是只关窗口。
    //
    // 为什么必须这样：macOS 上关掉最后一个窗口后应用**故意**继续存活
    // （`window-all-closed` 里 darwin 不 quit，这是 macOS 的标准约定，
    // 产品行为是对的）。而 Playwright 的 close() 等的是进程退出 ——
    // 于是每个用例都要卡满 10 秒兜底再被 SIGKILL，
    // 23 个用例就是 4.5 分钟，还顺带引发临时目录的 ENOTEMPTY 竞态。
    //
    // app.exit() 跳过 before-quit / close 那一套直接结束进程，三个平台行为一致。
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)

    // 兜底：万一 exit 没生效也不能让一个用例拖垮整个 worker
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000)).then(() => {
        app.process().kill('SIGKILL')
      }),
    ])
  },

  page: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.waitForSelector('.cm-content', { state: 'visible' })

    await use(page)

    // 关窗前把文档清空。
    //
    // 这不是「绕过」某个测试障碍，而是被应用的真实行为逼出来的：内容为脏时
    // 关闭窗口会弹出原生的「是否保存」对话框，而原生对话框在无头环境里
    // 没人能点，worker 就会一直卡到超时。空文档 == 未修改的新建文档，
    // 所以清空之后关闭流程不会弹窗。
    // 先关掉可能开着的浮层。命令面板的遮罩盖住整个窗口，
    // 不关的话下面那次点击会一直等到超时（每个用例白白多花 5 秒）
    await page.keyboard.press('Escape').catch(() => undefined)

    await page
      .locator(ACTIVE_CONTENT)
      .click({ timeout: 5_000 })
      .catch(() => undefined)
    await page.keyboard.press('ControlOrMeta+a').catch(() => undefined)
    await page.keyboard.press('Backspace').catch(() => undefined)
  },
})

export { expect } from '@playwright/test'

/**
 * 活动标签里的编辑区。
 *
 * 多标签下 `.cm-content` 会匹配到好几个（非活动标签只是 `hidden`，DOM 还在），
 * 而 Playwright 的严格模式对「匹配到多个」一律报错 —— 哪怕其中只有一个可见。
 * 所以所有辅助函数一律走这个作用域。
 */
export const ACTIVE_PAGE = '.tab-page:not([hidden])'
export const ACTIVE_CONTENT = `${ACTIVE_PAGE} .cm-content`

/** 把光标放到文档最前面并清空内容，让每个用例从干净状态开始。 */
export async function resetDoc(page: Page, text = ''): Promise<void> {
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  if (text) await page.keyboard.type(text)
}

/**
 * 用粘贴把一段文本放进编辑器。
 *
 * 为什么不用 `resetDoc` 逐字敲：多行文本要按 Enter，而 Enter 在表格里、
 * 在列表里都有各自的产品行为（续写标记、跳到下一行单元格）。
 * 想把一段**字面文本**放进去时，逐字敲反而是在测别的东西。
 *
 * 只放 `text/plain`，走的是产品自己的纯文本粘贴通路。
 */
export async function pasteText(page: Page, text: string): Promise<void> {
  await page.locator(ACTIVE_CONTENT).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.evaluate((payload) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', payload)
    document.querySelector('.tab-page:not([hidden]) .cm-content')!.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, text)
}

/** 让原生「打开」对话框直接返回指定路径。 */
export async function stubOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, paths)
}

/**
 * 在新窗口里打开一个真实文件，返回那个窗口。
 *
 * **一定要走这条，不要在用例里 `window.mosu.window.create(path)`。**
 * 那个 IPC 的入参完全由渲染进程决定，而修完 issue #4 之后它**不再授权**
 * 自己拿到的路径 —— 于是新窗口开得出来，文件却读不进去。
 *
 * 用例当初能过，靠的正是那个洞：路径白名单里凡是渲染进程自己说了算的入口，
 * 都是把整堵墙架空的入口。这里改走对话框，跟用户真实走的路一致，
 * 授权发生在「用户选中文件」的那一刻。
 */
export async function openDocInNewWindow(
  app: ElectronApplication,
  page: Page,
  target: string,
): Promise<Page> {
  const before = page.context().pages().length
  await stubOpenDialog(app, [target])
  await clickMenu(app, ['文件', '在新窗口打开…'])
  await expect
    .poll(() => page.context().pages().length, { timeout: 15_000 })
    .toBeGreaterThan(before)

  const created = page.context().pages().at(-1)
  if (!created) throw new Error('新窗口没有出现')
  await created.waitForSelector('.cm-content', { state: 'visible' })
  return created
}

/**
 * 打开设置面板。
 *
 * **位置按平台不同**：macOS 在应用菜单里（紧跟「关于」，那是 macOS 的老规矩），
 * Windows / Linux 在「视图」里。所以不能写死一条路径 —— 写死的那一刻，
 * 另一个平台上所有用到设置的用例都会挂在「菜单里找不到『设置…』」，
 * **而且只有那个平台的 CI 会红**。这个坑刚踩过一次（18 条用例一起翻）。
 *
 * 同理见下面的 `openCheckUpdates`。
 */
export async function openSettings(app: ElectronApplication): Promise<void> {
  await clickMenu(app, await menuPath(app, '设置…'))
}

/** 点「检查更新…」。位置同样按平台不同（mac 在应用菜单，其它在「帮助」）。 */
export async function openCheckUpdates(app: ElectronApplication): Promise<void> {
  await clickMenu(app, await menuPath(app, '检查更新…', '帮助'))
}

/** mac 上这一项在应用菜单里，其它平台在 `fallback` 那一栏。 */
async function menuPath(
  app: ElectronApplication,
  label: string,
  fallback = '视图',
): Promise<string[]> {
  const platform = await app.evaluate(() => process.platform)
  if (platform !== 'darwin') return [fallback, label]
  // 应用菜单那一栏的标签就是 app.name，别写死成 'Mosu'
  const appName = await app.evaluate(({ app: electronApp }) => electronApp.name)
  return [appName, label]
}

/** 点一个真实的原生菜单项，`labels` 是从顶层菜单往下的路径。 */
export async function clickMenu(app: ElectronApplication, labels: string[]): Promise<void> {
  await app.evaluate(({ Menu }, path) => {
    let items = Menu.getApplicationMenu()?.items ?? []
    let target: (typeof items)[number] | undefined
    for (const label of path) {
      target = items.find((item) => item.label === label)
      if (!target) throw new Error(`菜单里找不到「${label}」`)
      items = target.submenu?.items ?? []
    }
    target?.click()
  }, labels)
}

/**
 * 用户实际看到的文本（装饰生效后的 DOM 文本）。
 *
 * 注意：CodeMirror 只渲染视口内的行，所以这个函数只适用于短文档。
 * 端到端用例本来也不该拿几万行的文档来断言文本内容。
 */
export async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.tab-page:not([hidden]) .cm-line'))
      .map((line) => line.textContent ?? '')
      .join('\n'),
  )
}

/**
 * 编辑器缓冲区的真实文本 —— 也就是「保存下去会是什么」。
 *
 * 实现方式是**临时切到源码模式再读 DOM**，读完切回去。
 *
 * 为什么不去 window 上挂一个测试钩子：那会在生产代码里留一条只为测试存在的
 * 通道。而源码模式下装饰全部关闭，DOM 文本按定义就等于缓冲区文本 ——
 * 用产品自己的公开行为来观察，顺带还验证了「源码模式确实展示真实源码」。
 *
 * 直接读预览态的 DOM 是错的：那里的 `#` 被隐藏了、`-` 被换成了 `•`，
 * 读到的是渲染结果而不是源码。
 */
export async function docText(page: Page): Promise<string> {
  const toggle = page.locator('#status-mode')
  const alreadySource = (await toggle.getAttribute('aria-pressed')) === 'true'

  if (!alreadySource) await toggle.click()
  const text = await visibleText(page)
  if (!alreadySource) await toggle.click()

  return text
}
