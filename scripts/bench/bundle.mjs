/**
 * 主 bundle 体积（07 §2 的预算之一）。
 *
 * ## 为什么这一项**可以**当硬门槛，而时间指标不行
 *
 * 体积是确定的：同一份代码在任何机器上打出来都是同样的字节数。而「按键到渲染
 * p95」在共享的 CI runner 上受邻居负载影响，能差出两三倍 —— 把它设成硬门槛，
 * 结果不是「守住了性能」，是「一半的 PR 随机变红，于是大家学会了点 re-run」。
 * 那比没有门槛更糟：它训练所有人忽略这个信号。
 *
 * 所以：**体积卡死，时间只报告**（见 run.mjs 文件头）。
 *
 * ## 「主 bundle」的界定
 *
 * 指**启动时必须下载执行**的那部分：入口 chunk 加上 `index.html` 里以
 * `modulepreload` 声明的静态依赖。Mermaid、KaTeX、各语言高亮包都是动态
 * `import()`，它们各自成 chunk，不算在内 —— 这正是 07 §2 那句「一律懒加载，
 * 禁止进主 bundle」要守的东西。
 *
 * 界定方式是**读 `index.html` 里实际引用了什么**，而不是按文件名猜。Vite 的
 * chunk 名里有 20 个文件叫 `index-*.js`（每个包的 index.ts 各一个），
 * 按名字匹配会把懒加载的那些也算进来。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rendererDir = path.join(repoRoot, 'apps/desktop/dist/renderer')

/** 主 bundle 的预算，字节。3MB，见 07 §2。 */
export const MAIN_BUNDLE_BUDGET = 3 * 1024 * 1024

async function sizeOf(file) {
  return (await stat(file)).size
}

/**
 * 量一次主 bundle。
 *
 * @returns `{ entry, css, preload, main, total, lazy, lazyCount }`，单位字节。
 *   `main` 是要跟预算比的那个数（入口 JS + 静态预载 + CSS）。
 */
export async function measureBundle() {
  const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8')

  // 入口与静态预载：`<script src>`、`<link rel=modulepreload href>`、`<link rel=stylesheet href>`
  const referenced = new Set()
  for (const match of html.matchAll(/(?:src|href)="\.\/assets\/([^"]+)"/g)) {
    referenced.add(match[1])
  }
  if (referenced.size === 0) throw new Error('index.html 里一个资源都没引用 —— 是不是没构建？')

  let entry = 0
  let css = 0
  for (const name of referenced) {
    const size = await sizeOf(path.join(rendererDir, 'assets', name))
    if (name.endsWith('.css')) css += size
    else entry += size
  }

  // 懒加载的那些：assets 目录里除去被 index.html 直接引用的 JS
  const all = await readdir(path.join(rendererDir, 'assets'))
  let lazy = 0
  let lazyCount = 0
  for (const name of all) {
    if (!name.endsWith('.js') || referenced.has(name)) continue
    lazy += await sizeOf(path.join(rendererDir, 'assets', name))
    lazyCount++
  }

  const preload = await sizeOf(path.join(repoRoot, 'apps/desktop/dist/preload/index.cjs'))

  return { entry, css, preload, main: entry + css, lazy, lazyCount }
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function formatBundle(result) {
  return [
    `主 bundle：${mb(result.main)}（预算 ${mb(MAIN_BUNDLE_BUDGET)}）`,
    `  入口 JS ${mb(result.entry)} · CSS ${mb(result.css)}`,
    `懒加载：${mb(result.lazy)}，共 ${result.lazyCount} 个 chunk`,
    `preload：${(result.preload / 1024).toFixed(1)} KB`,
  ].join('\n')
}

// 直接跑时兼作门槛检查
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await measureBundle()
  console.log(formatBundle(result))
  if (result.main > MAIN_BUNDLE_BUDGET) {
    console.error(`\n主 bundle 超预算 ${mb(result.main - MAIN_BUNDLE_BUDGET)}`)
    process.exit(1)
  }
}
