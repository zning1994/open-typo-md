/**
 * 开发模式：Vite 开发服务器（渲染进程，带 HMR）+ esbuild watch（main/preload）
 * + 一个指向开发服务器的 Electron 实例。
 *
 * main / preload 改动会重启 Electron；渲染进程改动走 HMR，不重启。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import electronPath from 'electron'
import { createServer } from 'vite'
import { mainOptions, preloadOptions } from './build.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') })
await server.listen()
const devUrl = server.resolvedUrls?.local?.[0]
if (!devUrl) throw new Error('Vite 开发服务器没有返回可用地址')
server.printUrls()

let child = null
let restarting = false

function launch() {
  child = spawn(electronPath, [root], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl, NODE_ENV: 'development' },
  })
  child.on('exit', () => {
    if (!restarting) void shutdown(0)
  })
}

async function restart() {
  restarting = true
  child?.kill()
  await new Promise((resolve) => setTimeout(resolve, 120))
  restarting = false
  launch()
}

/** main / preload 重新构建完成后重启 Electron。 */
const restartOnRebuild = {
  name: 'restart-electron',
  setup(build) {
    let first = true
    build.onEnd(() => {
      if (first) {
        first = false
        return
      }
      void restart()
    })
  },
}

const contexts = await Promise.all([
  esbuild.context({ ...mainOptions, plugins: [...mainOptions.plugins, restartOnRebuild] }),
  esbuild.context({
    ...preloadOptions,
    plugins: [...preloadOptions.plugins, restartOnRebuild],
  }),
])
await Promise.all(contexts.map((ctx) => ctx.watch()))

launch()

async function shutdown(code) {
  restarting = true
  child?.kill()
  await Promise.all(contexts.map((ctx) => ctx.dispose()))
  await server.close()
  process.exit(code)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
