import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  _electron as electron,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

const appRoot = fileURLToPath(new URL('../apps/desktop', import.meta.url))

export interface TypoFixtures {
  app: ElectronApplication
  page: Page
  /** 每个用例独立的用户数据目录，避免设置互相污染。 */
  userDataDir: string
}

export const test = base.extend<TypoFixtures>({
  // eslint-disable-next-line no-empty-pattern
  userDataDir: async ({}, use) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'typo-e2e-'))
    await use(dir)
    await rm(dir, { recursive: true, force: true })
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

    // 优雅关闭走的是应用真实的关闭流程（含未保存确认），万一卡住就直接杀掉，
    // 免得一个用例的问题拖垮整个 worker
    await Promise.race([
      app.close(),
      new Promise((resolve) => setTimeout(resolve, 10_000)).then(() => {
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
    await page
      .locator('.cm-content')
      .click({ timeout: 5_000 })
      .catch(() => undefined)
    await page.keyboard.press('ControlOrMeta+a').catch(() => undefined)
    await page.keyboard.press('Backspace').catch(() => undefined)
  },
})

export { expect } from '@playwright/test'

/** 把光标放到文档最前面并清空内容，让每个用例从干净状态开始。 */
export async function resetDoc(page: Page, text = ''): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  if (text) await page.keyboard.type(text)
}

/**
 * 用户实际看到的文本（装饰生效后的 DOM 文本）。
 *
 * 注意：CodeMirror 只渲染视口内的行，所以这个函数只适用于短文档。
 * 端到端用例本来也不该拿几万行的文档来断言文本内容。
 */
export async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-line'))
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
