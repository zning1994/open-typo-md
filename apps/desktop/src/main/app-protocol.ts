/**
 * `typo-app://` 协议 —— 打包版本用它加载渲染进程的页面，而不是 `file://`。
 *
 * 为什么不用 file://（这不是洁癖，是实打实的 bug 来源）：
 * 1. CSP 的 `'self'` 在 file:// 源下不匹配任何东西，于是 `script-src 'self'`
 *    会把应用自己的 bundle 也挡掉，打包后直接白屏 —— 而开发模式（http://localhost）
 *    一切正常，所以这个问题只会在发版后被用户发现。
 * 2. file:// 源下没有正常的同源策略，一旦页面被注入脚本，读整块磁盘的门就开着。
 *
 * 换成自定义的 standard + secure 协议后，页面有了正常的源，CSP 与同源策略都能生效。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { protocol } from 'electron'

export const APP_SCHEME = 'typo-app'
export const APP_ORIGIN = `${APP_SCHEME}://bundle`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}

/** 必须在 app ready 之前调用。 */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])
}

/**
 * @param rendererDir 渲染进程构建产物所在目录（dist/renderer）
 */
export function registerAppHandler(rendererDir: string): void {
  const rootDir = path.resolve(rendererDir)

  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const target = path.resolve(rootDir, relative || 'index.html')

      // 即便是自家产物目录，也不允许被 ../ 走出去
      if (target !== rootDir && !target.startsWith(rootDir + path.sep)) {
        return new Response('越界访问', { status: 403 })
      }

      const bytes = await readFile(target)
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'content-type':
            MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        },
      })
    } catch {
      return new Response('未找到', { status: 404 })
    }
  })
}
