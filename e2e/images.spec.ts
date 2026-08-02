/**
 * 粘贴 / 拖入图片。
 *
 * 这条链路横跨三个进程 —— 剪贴板事件（renderer DOM）→ IPC → 白名单校验与
 * 落盘（main）→ 相对路径写回文档。单元测试各自覆盖了两端，但**中间接得对不对**
 * 只有真跑一遍才知道，所以这里做端到端。
 *
 * 图片字节靠合成的 `DataTransfer` 注入 —— 这不是绕过什么，而是唯一能在无头
 * 环境里稳定重现「粘贴一张截图」的方式：系统剪贴板在 CI 里既不可写也不可信。
 * 走的仍然是产品自己的 paste / drop 事件处理，一行都没跳过。
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { docText, expect, openDocInNewWindow, resetDoc, test } from './fixtures.js'
import type { Page } from '@playwright/test'

/** 1×1 的合法 PNG，base64。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * 在页面里合成一次粘贴。
 *
 * `dispatchEvent` 派发的是货真价实的 ClipboardEvent，编辑器的
 * `domEventHandlers.paste` 照常收到它 —— 我们只是自己填了 clipboardData。
 */
async function pasteImage(page: Page, name: string, mime = 'image/png'): Promise<void> {
  await page.evaluate(
    async ({ base64, name, mime }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], name, { type: mime }))
      document.querySelector('.cm-content')!.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      )
    },
    { base64: PNG_BASE64, name, mime },
  )
}

// 打开必须走 `openDocInNewWindow`（产品自己的对话框流程），不能直接调
// `fs.read`：附件要落在「当前文档旁边」，而渲染进程是否知道自己的路径，
// 恰恰是由这条打开流程决定的。

let dir: string

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mosu-img-'))
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

test('未保存的文档粘贴图片：文档一个字都不动', async ({ page }) => {
  // 新文档没有落脚目录。此时**绝不能**插入一个半截的 `![]()` ——
  // 那会留下一个永远加载不出来的引用。宿主弹框说明原因，文档保持原样。
  await resetDoc(page, '正文')
  await pasteImage(page, 'image.png')

  await expect.poll(() => docText(page)).toBe('正文')
})

test.describe('保存过的文档', () => {
  test('粘贴图片落进 assets/，文档里插入相对路径', async ({ app, page }) => {
    const target = path.join(dir, 'doc.md')
    await writeFile(target, '正文\n', 'utf8')
    const doc = await openDocInNewWindow(app, page, target)

    await doc.locator('.cm-content').click()
    await doc.keyboard.press('ControlOrMeta+End')
    await pasteImage(doc, 'image.png')

    // 落盘是异步的，等文档里出现引用
    await expect
      .poll(() => docText(doc), { timeout: 10_000 })
      .toMatch(/!\[\]\(assets\/[0-9a-f]{16}\.png\)/)

    expect(await readdir(path.join(dir, 'assets'))).toHaveLength(1)

    await resetDoc(doc)
  })

  test('截图粘贴不生成 alt，拖入的具名文件用文件名做 alt', async ({ app, page }) => {
    const target = path.join(dir, 'doc.md')
    await writeFile(target, '', 'utf8')
    const doc = await openDocInNewWindow(app, page, target)

    await doc.locator('.cm-content').click()
    // Chromium 给截图合成的文件名恒为 image.png，拿它当 alt 是纯噪声
    await pasteImage(doc, 'image.png')
    await expect.poll(() => docText(doc), { timeout: 10_000 }).toContain('![](assets/')

    await resetDoc(doc)
    await pasteImage(doc, '架构图.png')
    await expect.poll(() => docText(doc), { timeout: 10_000 }).toContain('![架构图](assets/')

    await resetDoc(doc)
  })

  test('同一张图粘两次只落一个文件（内容哈希去重）', async ({ app, page }) => {
    const target = path.join(dir, 'doc.md')
    await writeFile(target, '', 'utf8')
    const doc = await openDocInNewWindow(app, page, target)

    await doc.locator('.cm-content').click()
    await pasteImage(doc, 'a.png')
    await expect.poll(() => docText(doc), { timeout: 10_000 }).toContain('assets/')
    await pasteImage(doc, 'b.png')
    await expect
      .poll(() => docText(doc), { timeout: 10_000 })
      .toMatch(/assets\/[\s\S]*assets\//)

    expect(await readdir(path.join(dir, 'assets'))).toHaveLength(1)

    await resetDoc(doc)
  })

  test('非图片类型不接管粘贴', async ({ app, page }) => {
    const target = path.join(dir, 'doc.md')
    await writeFile(target, '', 'utf8')
    const doc = await openDocInNewWindow(app, page, target)

    await doc.locator('.cm-content').click()
    await pasteImage(doc, 'evil.sh', 'application/x-sh')

    // 编辑器压根不该接管它，assets/ 也就不该出现
    await expect(readdir(path.join(dir, 'assets'))).rejects.toThrow()

    await resetDoc(doc)
  })
})
