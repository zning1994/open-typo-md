/**
 * 把 preload 暴露的 API 适配成内核认识的 HostBridge。
 *
 * 这一层看起来是重复劳动，其实是原则 P3 的落地：@mosu/editor 只认识
 * HostBridge，不认识 `window.mosu`。换个宿主（Web 版、VS Code 插件）时，
 * 要改的只有这个文件。
 */
import type { HostBridge } from '@mosu/plugin-api'
import type { MosuBridgeApi } from '../shared/channels.js'

declare global {
  interface Window {
    mosu: MosuBridgeApi
  }
}

export function getBridgeApi(): MosuBridgeApi {
  const api = window.mosu
  if (!api) throw new Error('preload 未注入 —— 这通常意味着窗口配置被改坏了')
  return api
}

export function createHostBridge(): HostBridge {
  const api = getBridgeApi()
  return {
    fs: {
      read: (path) => api.fs.read(path),
      write: (path, text, options) => api.fs.write(path, text, options),
      list: (dir) => api.fs.list(dir),
      exists: (path) => api.fs.exists(path),
      resolveAssetUrl: async (path, baseDir) => buildAssetUrl(baseDir, path),
      saveAttachment: (baseDir, attachment) =>
        api.fs.saveAttachment(baseDir, attachment.mime, attachment.bytes),
    },
    dialog: {
      openFile: (options) => api.dialog.open(options),
      saveFile: (options) => api.dialog.save(options),
      confirm: (options) => api.dialog.confirm(options),
      message: (options) => api.dialog.message(options),
    },
    shell: {
      openExternal: (url) => api.shell.openExternal(url),
    },
    settings: {
      get: <T>(key: string) => api.settings.get(key) as Promise<T | undefined>,
      set: (key, value) => api.settings.set(key, value),
    },
    platform: api.platform,
  }
}

/**
 * 构造 `mosu-asset://` URL。
 *
 * 只做字符串拼接，不做路径解析 —— `../` 的规范化与白名单校验一律在 main 侧
 * 完成（见 main/asset-protocol.ts 的说明）。
 */
export function buildAssetUrl(baseDir: string, src: string): string {
  const params = new URLSearchParams({ base: baseDir, src })
  return `mosu-asset://local/?${params.toString()}`
}

/** 取路径的目录部分。渲染进程没有 node:path，只能自己切。 */
export function dirnameOf(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return index <= 0 ? filePath.slice(0, index + 1) || '/' : filePath.slice(0, index)
}

export function basenameOf(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return index === -1 ? filePath : filePath.slice(index + 1)
}

/**
 * 图片路径解析。
 *
 * 远程地址与 data URI 原样返回 —— 但注意 CSP 里 img-src **不包含** http(s)，
 * 所以远程图片默认加载不出来，会走 ImageWidget 的失败降级显示源码。
 * 这是设计上的选择（架构 01 §6）：不让文档变成追踪信标。
 */
export function createAssetResolver(getBaseDir: () => string | null) {
  return (src: string): string => {
    if (/^(https?:|data:|blob:|mosu-asset:)/i.test(src)) return src
    const baseDir = getBaseDir()
    if (!baseDir) return src
    return buildAssetUrl(baseDir, src)
  }
}
