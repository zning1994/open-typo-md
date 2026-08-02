/**
 * 打包 main / preload / renderer 三部分。
 *
 * main 与 preload 用 esbuild 直接打成自包含的 CJS —— 这样 electron-builder
 * 的 `files` 只需要 `dist/**`，不必把 node_modules 塞进安装包，
 * 也绕开了 pnpm 软链接结构和 asar 打包之间的一堆坑。
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import { build as viteBuild } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const alias = {
  '@mosu/plugin-api': path.join(root, '../../packages/plugin-api/src/index.ts'),
  '@mosu/plugin-api/testing': path.join(root, '../../packages/plugin-api/src/testing/index.ts'),
  '@mosu/markdown/text': path.join(root, '../../packages/markdown/src/text.ts'),
  '@mosu/markdown': path.join(root, '../../packages/markdown/src/index.ts'),
  '@mosu/editor': path.join(root, '../../packages/editor/src/index.ts'),
}

/** 把工作区包名解析到源码文件 —— esbuild 没有 vite 那样的 alias 配置项。 */
const workspaceAlias = {
  name: 'mosu-workspace-alias',
  setup(build) {
    const pattern = /^@mosu\//
    build.onResolve({ filter: pattern }, (args) => {
      const target = alias[args.path]
      return target ? { path: target } : null
    })
  },
}

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  // electron 由运行时提供，绝不能打进包里
  external: ['electron'],
  plugins: [workspaceAlias],
  logLevel: 'info',
}

export const mainOptions = {
  ...common,
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(root, 'dist/main/index.cjs'),
}

export const preloadOptions = {
  ...common,
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  outfile: path.join(root, 'dist/preload/index.cjs'),
}

export async function buildAll() {
  await rm(path.join(root, 'dist'), { recursive: true, force: true })
  await Promise.all([esbuild.build(mainOptions), esbuild.build(preloadOptions)])
  await viteBuild({ configFile: path.join(root, 'vite.config.ts') })
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  await buildAll()
}
