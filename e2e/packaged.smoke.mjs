/**
 * 打包产物的冒烟测试。
 *
 * e2e 跑的是源码目录，验不到「装进 asar 之后还能不能起来」——
 * 而排除 node_modules 这类打包配置的改动，恰恰只在打包产物里才会出问题。
 */
import { _electron as electron } from '@playwright/test'

const app = await electron.launch({
  executablePath: 'release/linux-unpacked/mosu',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
})
const page = await app.firstWindow()
page.on('console', (m) => console.log('CONSOLE', m.type(), m.text()))
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
await page.waitForSelector('.cm-content', { state: 'visible', timeout: 20000 })

await page.locator('.cm-content').click()
// 末尾要留一段无关文字：光标停在公式旁边时公式会**正确地**显形成源码，
// 那时断言渲染结果只会验出一个假失败
await page.keyboard.type('# 标题\n\n**粗体** 与 $E=mc^2$ 的说明\n\n结尾段落')
await page.waitForTimeout(3000)

const checks = {
  标题: await page.locator('.cm-mosu-h1').count(),
  粗体: await page.locator('.cm-mosu-strong').count(),
  公式: await page.locator('.cm-mosu-math .katex').count(),
}
console.log('SMOKE', JSON.stringify(checks))
await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
await app.close().catch(() => undefined)

const ok = checks.标题 > 0 && checks.粗体 > 0 && checks.公式 > 0
process.exit(ok ? 0 : 1)
