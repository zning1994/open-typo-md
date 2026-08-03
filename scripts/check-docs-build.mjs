/**
 * 文档站构建之后：**每一页都得有正文**。
 *
 * ## 为什么需要这个
 *
 * VitePress 在服务端渲染某一页出错时会**吞掉异常**：构建照常退出 0，产物里
 * 那一页的外壳（导航、侧栏、页脚）一应俱全，只有 `<main>` 是空的。于是
 * 「建站绿了」和「页面能看」变成了两件事 —— 线上空了一页，CI 一声不吭。
 *
 * 真实发生过一次：`docs/design/00-overview.md` 里一句行内代码
 * `` `${{ github.repository }}` `` 被 Vue 当成插值编译（围栏代码块会自动包
 * `v-pre`，行内代码不会），SSR 时求值抛异常，整页正文没了。是用户在线上
 * 看到空白页才发现的。
 *
 * ## 为什么挂在 `docs:build` 里而不是某个 workflow 的步骤上
 *
 * 站点有两条构建路径（Docs 检查、Pages 部署）。挂成步骤就得记得两边都加，
 * 而且将来多一条路径就多一次漏的机会。挂进 npm script 之后，**任何人用任何
 * 方式构建站点都躲不开它** —— 包括本地。
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const DIST = new URL('../docs/.vitepress/dist/', import.meta.url)

/**
 * 正文短于这个字数就算「空的」。
 *
 * 不用「等于 0」：出错的页面 `<main>` 里还会剩下几个空标签。也不定得太高 ——
 * 站点里确实有短页面（语言落地页）。80 个可见字符是「一段像样的话」的下限。
 */
const MIN_TEXT = 80

/** 不参与检查的页面。404 页按定义就没有正文。 */
const EXEMPT = new Set(['404.html'])

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* htmlFiles(full)
    else if (entry.name.endsWith('.html')) yield full
  }
}

/**
 * 正文区里的可见文字。标签、脚本、样式都不算。
 *
 * 两种容器都要认：普通文档页是 `<main>`，首页那种 `layout: home` 的页面
 * 根本没有 `<main>`，内容挂在 `.VPHome` 下面。只认一种的话，三个落地页会被
 * 判成「没有正文」—— 那是**假阳性**，比不检查更糟：下一个人只会把它们加进
 * 豁免名单，而豁免名单一旦开了口子就会越来越长。
 */
function contentText(html) {
  const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)
  const home = /<div class="VPHome"[^>]*>([\s\S]*?)<footer/.exec(html)
  const inner = main?.[1] ?? home?.[1]
  if (inner === undefined) return null
  return inner
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const root = path.normalize(DIST.pathname)
const empty = []
let checked = 0

for await (const file of htmlFiles(root)) {
  const name = path.relative(root, file)
  if (EXEMPT.has(path.basename(name))) continue

  const text = contentText(await readFile(file, 'utf8'))
  checked++
  // `<main>` 整个不见了跟正文为空是同一类失败，一起报
  if (text === null || text.length < MIN_TEXT) {
    empty.push({ name, length: text === null ? '找不到正文容器' : `${text.length} 字` })
  }
}

if (empty.length > 0) {
  console.error(`\n构建出来的站点里有 ${empty.length} 页没有正文：\n`)
  for (const { name, length } of empty) console.error(`  ${name}（${length}）`)
  console.error(
    '\nVitePress 渲染出错时会吞掉异常、照常退出 0，所以这里单独查一遍。' +
      '\n最常见的原因是 Markdown 里的 Vue 语法：`{{ … }}`、`<` 开头的裸标签。' +
      '\n重新跑一次 `pnpm docs:build` 看有没有 TypeError 被打在 rendering pages 那一步。\n',
  )
  process.exit(1)
}

console.log(`✓ 文档站 ${checked} 页都有正文`)
