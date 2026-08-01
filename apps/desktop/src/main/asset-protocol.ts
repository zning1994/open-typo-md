/**
 * `typo-asset://` 自定义协议。
 *
 * 为什么不用 `file://`（架构 01 §6）：`file://` 一旦允许，渲染进程就能读取
 * 整个磁盘。自定义协议让我们在每次资源请求上都过一遍白名单。
 *
 * URL 形式：
 *   typo-asset://local/?base=<文档所在目录>&src=<Markdown 里写的路径>
 *
 * 路径拼接刻意放在 main 侧做，渲染进程只负责传原始字符串 —— 让 `../../..`
 * 这类穿越尝试必须经过这里的规范化与校验。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { protocol } from 'electron'
import { assertAllowed } from './path-guard.js'

export const ASSET_SCHEME = 'typo-asset'

/** 必须在 app ready 之前调用。 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false },
    },
  ])
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

/** 只放行图片。文档里引用一个 .sh 不该变成可读取任意文件的通道。 */
function mimeFor(target: string): string | null {
  return MIME[path.extname(target).toLowerCase()] ?? null
}

export function registerAssetHandler(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const base = url.searchParams.get('base')
      const src = url.searchParams.get('src')
      if (!base || !src) return new Response('缺少参数', { status: 400 })

      const resolved = path.resolve(base, src)
      const mime = mimeFor(resolved)
      if (!mime) return new Response('不支持的资源类型', { status: 415 })

      // 白名单校验（含符号链接解析），越权直接 403
      const real = await assertAllowed(resolved)
      const bytes = await readFile(real)
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': mime, 'cache-control': 'no-cache' },
      })
    } catch {
      return new Response('无法访问', { status: 403 })
    }
  })
}

/** 供渲染进程构造 URL 用的辅助函数（同样的规则，写在一处）。 */
export function buildAssetUrl(baseDir: string, src: string): string {
  const params = new URLSearchParams({ base: baseDir, src })
  return `${ASSET_SCHEME}://local/?${params.toString()}`
}
