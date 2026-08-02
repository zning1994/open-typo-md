/**
 * 文件监听与外部修改（docs/design/04 §3）。
 *
 * 这一套**必须**跑在真实文件系统上。watcher.ts 里那三条注释写的都是
 * 只有在真 inotify / FSEvents 上才会出现的问题：
 *
 * 1. 一次保存会放出好几个事件（写临时文件 → rename）；
 * 2. 自己保存不该惊动自己；
 * 3. 原子替换换掉 inode 之后，旧 watch 从此再也收不到事件。
 *
 * 第 3 条尤其阴险：只测「改一次能不能发现」是发现不了它的，
 * 必须改**两次**。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { docText, expect, test } from './fixtures.js'
import type { Page } from '@playwright/test'

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mosu-watch-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

/** 在新窗口里打开一个真实文件。 */
async function openDoc(page: Page, name: string, content: string): Promise<[Page, string]> {
  const target = path.join(dir, name)
  await writeFile(target, content, 'utf8')

  const before = page.context().pages().length
  await page.evaluate((p) => window.mosu.window.create(p), target)
  await expect
    .poll(() => page.context().pages().length, { timeout: 15_000 })
    .toBeGreaterThan(before)

  const created = page.context().pages().at(-1)
  if (!created) throw new Error('新窗口没有出现')
  await created.waitForSelector('.cm-content', { state: 'visible' })
  // 等文档真的装进去了
  await expect.poll(() => docText(created), { timeout: 10_000 }).toContain(content.trim())
  return [created, target]
}

test('外部修改在没有本地改动时静默重载', async ({ page }) => {
  // git checkout、外部格式化、云盘同步都走这条路。没有任何东西会丢，就不该问
  const [doc, target] = await openDoc(page, 'a.md', '原来的内容\n')

  await writeFile(target, '别的程序写的内容\n', 'utf8')

  await expect.poll(() => docText(doc), { timeout: 10_000 }).toContain('别的程序写的内容')
})

test('连改两次都能发现 —— 原子替换换掉 inode 之后 watch 会重新挂', async ({ page }) => {
  const [doc, target] = await openDoc(page, 'b.md', '第 0 版\n')

  await writeFile(target, '第 1 版\n', 'utf8')
  await expect.poll(() => docText(doc), { timeout: 10_000 }).toContain('第 1 版')

  // 模拟原子替换：写临时文件再 rename，旧 inode 就此作废
  const tmp = path.join(dir, '.b.md.tmp')
  await writeFile(tmp, '第 2 版\n', 'utf8')
  await page.evaluate(async () => undefined) // 让上一轮事件先落地
  const { rename } = await import('node:fs/promises')
  await rename(tmp, target)

  await expect.poll(() => docText(doc), { timeout: 10_000 }).toContain('第 2 版')
})

test('自己保存不会惊动自己', async ({ page }) => {
  // 不做 selfWritten 登记的话，每保存一次都会报一次「文件被外部修改」。
  //
  // 直接数 fileChanged 事件，而不是去看有没有弹框：弹框在无头环境里点不了，
  // 一旦真的弹出来这条用例会挂死而不是失败。数事件既确定又快。
  const [doc, target] = await openDoc(page, 'c.md', '初始\n')

  await doc.evaluate(() => {
    const w = window as unknown as { __changes: number }
    w.__changes = 0
    window.mosu.on.fileChanged(() => {
      w.__changes++
    })
  })

  // 走**产品保存文件用的同一个 IPC 通道**。连写三次：单次通过可能只是
  // 侥幸赢了去抖窗口，连续几次才能把「登记发生在写入之前」真正验出来
  for (const n of [1, 2, 3]) {
    await doc.evaluate(
      async ({ path, text }) => {
        await window.mosu.fs.write(path, text, {
          meta: { encoding: 'utf8', eol: 'lf', mixedEol: false },
          expectedHash: null,
        })
      },
      { path: target, text: `我们自己写的内容 ${n}\n` },
    )
  }
  expect(await readFile(target, 'utf8')).toContain('我们自己写的内容 3')

  // 去抖窗口 120ms，给足时间让误报有机会发生
  await page.waitForTimeout(800)
  expect(await doc.evaluate(() => (window as unknown as { __changes: number }).__changes)).toBe(
    0,
  )

  // 而真正的外部修改必须照常报上来 —— 否则「不惊动自己」就退化成「什么都不报」
  await writeFile(target, '别的程序写的\n', 'utf8')
  await expect
    .poll(() => doc.evaluate(() => (window as unknown as { __changes: number }).__changes), {
      timeout: 10_000,
    })
    .toBe(1)
})

test('文件被删除时保住缓冲区内容', async ({ page }) => {
  // 缓冲区里的内容此刻是唯一一份，自动重载会把它抹掉
  const [doc, target] = await openDoc(page, 'd.md', '很重要的内容\n')

  await doc.locator('.cm-content').click()
  await doc.keyboard.press('ControlOrMeta+End')
  await doc.keyboard.type('还没保存的部分')

  await rm(target)

  await expect(doc.locator('#status-meta')).toContainText('文件已删除', { timeout: 10_000 })
  expect(await docText(doc)).toContain('还没保存的部分')
  expect(await docText(doc)).toContain('很重要的内容')
})
