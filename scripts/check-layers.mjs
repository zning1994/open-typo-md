/**
 * 分层依赖方向检查（架构 01 §1）。
 *
 * 规则：依赖只能向下。`@typo/markdown` 不认识编辑器，`@typo/editor` 不认识 UI，
 * 内核不认识 Electron。这条规则一旦被破坏，「内核可嵌入、可脱离 Electron 测试」
 * 的能力就没了 —— 而且通常是在某次「就加一个 import」之后悄悄没的。
 *
 * 没有引 dependency-cruiser：这条规则用四十行就能查完，不值得再多一个依赖。
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** 每个包**允许**依赖的工作区包。未列出的一律视为违规。 */
const ALLOWED = {
  '@typo/plugin-api': [],
  '@typo/markdown': ['@typo/plugin-api'],
  // 导出层认识语义解析，但**不认识编辑器** —— 导出不该依赖「界面上现在是什么样」
  '@typo/export': ['@typo/plugin-api', '@typo/markdown'],
  '@typo/editor': ['@typo/plugin-api', '@typo/markdown'],
  '@typo/desktop': ['@typo/plugin-api', '@typo/markdown', '@typo/export', '@typo/editor'],
}

/** 这些包的源码里不允许出现的 import —— 内核必须与宿主无关（原则 P3）。 */
const FORBIDDEN_IMPORTS = {
  '@typo/plugin-api': [/^electron$/, /^node:/],
  '@typo/markdown': [/^electron$/, /^node:/],
  '@typo/export': [/^electron$/, /^node:/],
  '@typo/editor': [/^electron$/, /^node:/],
}

const errors = []

async function listPackages() {
  const dirs = []
  for (const group of ['packages', 'apps']) {
    const base = path.join(root, group)
    for (const name of await readdir(base)) {
      dirs.push(path.join(base, name))
    }
  }
  return dirs
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else if (/\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

const IMPORT_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g

for (const dir of await listPackages()) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  const name = manifest.name
  const allowed = ALLOWED[name]
  if (!allowed) {
    errors.push(`未知的工作区包 ${name} —— 请在 scripts/check-layers.mjs 里为它声明允许的依赖`)
    continue
  }

  // 1) package.json 里声明的工作区依赖
  const declared = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }).filter((dep) => dep.startsWith('@typo/'))
  for (const dep of declared) {
    if (!allowed.includes(dep)) {
      errors.push(`${name} 不允许依赖 ${dep}（package.json）`)
    }
  }

  // 2) 源码里实际写下的 import —— 声明与实际都要查，两者都可能先跑偏
  const forbidden = FORBIDDEN_IMPORTS[name] ?? []
  const files = await walk(path.join(dir, 'src')).catch(() => [])
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1]
      const rel = path.relative(root, file)

      if (specifier.startsWith('@typo/')) {
        const target = specifier.split('/').slice(0, 2).join('/')
        if (target !== name && !allowed.includes(target)) {
          errors.push(`${rel} 不允许 import ${specifier}`)
        }
      }
      for (const pattern of forbidden) {
        // testing 子入口只供测试使用，允许它碰宿主 API
        if (pattern.test(specifier) && !rel.includes(`${path.sep}testing${path.sep}`)) {
          errors.push(`${rel} 不允许 import ${specifier}（该包必须与宿主环境无关）`)
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error('分层依赖检查未通过：\n')
  for (const error of errors) console.error(`  ✗ ${error}`)
  console.error('\n规则见 docs/design/01-architecture.md §1')
  process.exit(1)
}

console.log('✓ 分层依赖方向正确')
