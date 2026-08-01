/**
 * 会话恢复（docs/adr/0005 §关键推论 5）。
 *
 * 这条用例必须**真的重启一次应用** —— 会话恢复的全部意义就在跨进程那一刻，
 * 在一个进程里模拟它等于什么都没验。所以这个文件不用 `app` fixture，
 * 自己起两次 Electron，共用同一个 userData 目录。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

const appRoot = fileURLToPath(new URL('../apps/desktop', import.meta.url))

// 每条用例要完整启动两次 Electron（外加一次干净退出），Windows 的 CI 机器上
// 这一套走下来就逼近默认的 60 秒了 —— 放宽的是耐心，不是断言
test.setTimeout(150_000)

let userDataDir: string
let workDir: string

test.beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'typo-session-ud-'))
  workDir = await mkdtemp(path.join(tmpdir(), 'typo-session-'))
})

test.afterEach(async () => {
  for (const dir of [userDataDir, workDir]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => undefined,
    )
  }
})

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      appRoot,
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
    env: { ...process.env, NODE_ENV: 'test' },
  })
}

/** 干净地退出：走 close 而不是 exit，会话才有机会落盘。 */
async function quit(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 8_000)).then(() =>
      app.process().kill('SIGKILL'),
    ),
  ])
}

test('重启之后恢复上次的工作区与标签', async () => {
  const first = path.join(workDir, '甲.md')
  const second = path.join(workDir, '乙.md')
  await writeFile(first, '甲的内容', 'utf8')
  await writeFile(second, '乙的内容', 'utf8')

  const app1 = await launch()
  const page1 = await app1.firstWindow()
  await page1.waitForSelector('.cm-content', { state: 'visible' })

  await app1.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
  }, workDir)
  await app1.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === '文件')
    file?.submenu?.items.find((i) => i.label === '打开文件夹…')?.click()
  })
  await expect(page1.locator('.typo-files')).toBeVisible()

  await page1.locator('.typo-files__item').filter({ hasText: '甲.md' }).click()
  await page1.locator('.typo-files__item').filter({ hasText: '乙.md' }).click()
  await expect(page1.locator('.tab-bar .tab')).toHaveCount(2)

  // 等会话落盘（渲染进程 300ms 防抖 + main 侧 400ms 防抖）
  const sessionFile = path.join(userDataDir, 'session.json')
  await expect
    .poll(() => readFile(sessionFile, 'utf8').catch(() => ''), { timeout: 15_000 })
    .toContain('乙.md')

  await quit(app1)

  const app2 = await launch()
  const page2 = await app2.firstWindow()
  await page2.waitForSelector('.cm-content', { state: 'visible' })

  // 工作区回来了
  await expect(page2.locator('.typo-files')).toBeVisible({ timeout: 20_000 })
  await expect(page2.locator('.typo-files__title')).toHaveText(path.basename(workDir))
  // 两个标签也回来了
  await expect(page2.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 20_000 })

  await quit(app2)
})

test('上次的文件被删掉时，静默跳过它，其余照常恢复', async () => {
  const kept = path.join(workDir, '留下.md')
  const gone = path.join(workDir, '会被删掉.md')
  await writeFile(kept, '留下的内容', 'utf8')
  await writeFile(gone, '要没的内容', 'utf8')

  const app1 = await launch()
  const page1 = await app1.firstWindow()
  await page1.waitForSelector('.cm-content', { state: 'visible' })

  await app1.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
  }, workDir)
  await app1.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === '文件')
    file?.submenu?.items.find((i) => i.label === '打开文件夹…')?.click()
  })
  await page1.locator('.typo-files__item').filter({ hasText: '留下.md' }).click()
  await page1.locator('.typo-files__item').filter({ hasText: '会被删掉.md' }).click()
  await expect(page1.locator('.tab-bar .tab')).toHaveCount(2)

  await expect
    .poll(() => readFile(path.join(userDataDir, 'session.json'), 'utf8').catch(() => ''), {
      timeout: 15_000,
    })
    .toContain('会被删掉.md')
  await quit(app1)

  await rm(gone)

  const app2 = await launch()
  const page2 = await app2.firstWindow()
  await page2.waitForSelector('.cm-content', { state: 'visible' })

  // 上次会话里的某个文件不在了是很正常的事，不该为它弹错误框挡住启动
  await expect(page2.locator('.tab-bar')).toBeHidden({ timeout: 20_000 })
  await expect
    .poll(() =>
      page2.evaluate(
        () => document.querySelector('.tab-page:not([hidden]) .cm-content')?.textContent ?? '',
      ),
    )
    .toContain('留下的内容')

  await quit(app2)
})
