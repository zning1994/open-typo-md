/**
 * 无障碍扫描（docs/design/07 §3）。
 *
 * 07 说的是「axe-core 扫主要界面，违规项进看板」。这里比那句更严一点：
 * **扫出来的违规直接让用例失败**。理由是现在违规数是 0 —— 从 0 守住 0 很容易，
 * 而一旦允许「进看板」，那个看板就会一直有东西，然后没人看。
 *
 * ## 自动扫描能查到什么、查不到什么
 *
 * axe 能查的是**机器可判定**的那一类：对比度、缺 label、ARIA 属性用错、
 * 标题层级跳跃、焦点陷阱的一部分。
 *
 * 它查不到的（07 §3 里恰恰最重要的那几条）：
 *
 * - 读屏软件把二级标题读成「标题 二级：安装」而不是「井号 井号 安装」；
 * - widget 能不能用键盘进出（Enter 进 / Esc 出）；
 * - 焦点顺序合不合理。
 *
 * 这些要靠别处的用例和人工验证。所以**这个文件通过 ≠ 无障碍做好了**，
 * 它只是把「机器能发现的错」清零。
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { ACTIVE_CONTENT, clickMenu, expect, openSettings, resetDoc, test } from './fixtures.js'
import type { Page } from '@playwright/test'

/**
 * 自己注入 axe，绕开两个坑。
 *
 * 1. **不用 `@axe-core/playwright`。** 它内部会调 `browserContext.newPage()`
 *    （为了在一个干净页面里跑规则），而 Electron 的 context 不支持开新页 ——
 *    报错是 `Protocol error (Target.createTarget): Not supported`，
 *    看不出跟无障碍有什么关系。
 *
 * 2. **不用 `page.addScriptTag()`。** 产品的 CSP 是 `script-src 'self'`
 *    （main/index.ts），插一个内联 script 会被当场拒掉 —— 这是**对的**，
 *    正是我们想要的安全姿态，绝不能为了测试把它放宽。
 *    `page.evaluate(源码字符串)` 走的是 CDP 的 `Runtime.evaluate`，不经过页面的
 *    脚本加载通道，因此不受 CSP 约束，也不需要 `unsafe-eval`。
 */
const require_ = createRequire(import.meta.url)
const axeSource = readFile(
  path.join(path.dirname(require_.resolve('axe-core')), 'axe.min.js'),
  'utf8',
)

interface Violation {
  id: string
  impact: string | null
  nodes: { target: string[] }[]
}

/**
 * 扫一遍当前界面。
 *
 * 只跑 WCAG 2.1 A/AA 的规则集：AAA 里有些条目（比如所有正文都要 7:1 对比度）
 * 对一个编辑器不适用 —— 高对比主题是专门为那个场景准备的，
 * 让默认主题也去满足 AAA 只会把配色逼成黑白。
 */
async function scan(page: Page, include?: string): Promise<Violation[]> {
  const injected = await page.evaluate(() => 'axe' in window)
  if (!injected) await page.evaluate(await axeSource)

  const results = await page.evaluate(async (target) => {
    const axe = (
      window as unknown as {
        axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Violation[] }> }
      }
    ).axe
    const context = target ? { include: [[target]] } : document
    return axe.run(context, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    })
  }, include ?? null)
  return results.violations
}

/** 违规列表压成人能读的形式 —— 默认的报告对象在断言失败时刷屏。 */
function summarize(violations: Violation[]) {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(' ')),
  }))
}

test('主界面（编辑区 + 状态栏）没有违规', async ({ page }) => {
  await resetDoc(page, '# 标题\n\n正文，带 **加粗** 与 `代码`。\n\n- [ ] 任务\n')
  expect(summarize(await scan(page))).toEqual([])
})

test('设置面板没有违规', async ({ app, page }) => {
  await openSettings(app)
  await expect(page.locator('.mosu-settings')).toBeVisible()
  expect(summarize(await scan(page, '.mosu-settings'))).toEqual([])
  await page.keyboard.press('Escape')
})

test('命令面板没有违规', async ({ app, page }) => {
  await clickMenu(app, ['视图', '命令面板'])
  await expect(page.locator('.mosu-palette')).toBeVisible()
  expect(summarize(await scan(page, '.mosu-palette'))).toEqual([])
  await page.keyboard.press('Escape')
})

test('大纲面板没有违规', async ({ app, page }) => {
  await resetDoc(page, '# 一级\n\n## 二级\n\n### 三级\n\n正文\n')
  await clickMenu(app, ['视图', '大纲'])
  await expect(page.locator('.mosu-outline')).toBeVisible()
  expect(summarize(await scan(page, '.mosu-outline'))).toEqual([])
  await clickMenu(app, ['视图', '大纲'])
})

test('高对比主题下对比度依然达标', async ({ app, page }) => {
  // 这条不是重复：默认主题过了不代表每套主题都过，而高对比主题的**全部意义**
  // 就是对比度。它要是不达标，那这套主题就是个摆设
  await resetDoc(page, '# 标题\n\n正文，带 **加粗**、`代码` 与 [链接](https://example.com)。\n')
  await clickMenu(app, ['视图', '主题', '高对比'])
  await expect(page.locator('html')).toHaveAttribute('data-mosu-theme', 'high-contrast')

  expect(summarize(await scan(page))).toEqual([])

  await clickMenu(app, ['视图', '主题', '浅色'])
})

test('系统开了「增强对比度」时，专注模式不再变暗', async ({ app, page }) => {
  // 这条**不能靠 axe 验**。第一版就是这么写的，而且「通过」了 —— 后来去看
  // 才发现 axe 把变暗的行全归进了 `incomplete`（「背景被别的元素盖住，
  // 判定不了」），`violations` 自然是空的。一条永远通过的用例比没有用例更糟。
  //
  // 所以直接量：读 CSS 变量的实际取值。变暗用的是 opacity，
  // 0.35 下正文只有 2.1:1，够不着 WCAG AA —— 取舍写在 07 §3.1。
  // 这里能守住的是「系统说了要对比度，我们就不压」。
  await resetDoc(page, '第一段\n\n第二段\n\n第三段\n')
  await clickMenu(app, ['视图', '专注模式'])
  await expect(page.locator('.cm-mosu-dim').first()).toBeVisible()

  const dimOf = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--mosu-focus-dim').trim(),
    )

  expect(Number(await dimOf())).toBeLessThan(1)

  await page.emulateMedia({ contrast: 'more' })
  expect(Number(await dimOf())).toBe(1)

  await page.emulateMedia({ contrast: 'no-preference' })
  await clickMenu(app, ['视图', '专注模式'])
})

test('专注模式变暗的行，结构上仍然是可选中的正文', async ({ app, page }) => {
  // opacity 只改视觉。变暗的行绝不能顺手加上 aria-hidden 之类的东西 ——
  // 那会让读屏用户在专注模式下「丢失」整篇文档的其余部分
  await resetDoc(page, '第一段\n\n第二段\n\n第三段\n')
  await clickMenu(app, ['视图', '专注模式'])
  const dim = page.locator(`${ACTIVE_CONTENT} .cm-mosu-dim`).first()
  await expect(dim).toBeVisible()
  await expect(dim).not.toHaveAttribute('aria-hidden', 'true')
  await expect(dim).toHaveText('第一段')

  await clickMenu(app, ['视图', '专注模式'])
})

test('页面语言标记跟界面语言一致', async ({ page }) => {
  // 读屏软件靠 `<html lang>` 选发音。标错的后果不是「读不出来」，
  // 是「用英文发音念中文」—— 比没标还难听
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
})
