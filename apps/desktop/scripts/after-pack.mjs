/**
 * 打包后钩子：给未配置证书的 macOS 构建打上**临时签名（ad-hoc）**。
 *
 * 为什么需要：
 * Apple Silicon 要求所有 arm64 可执行文件至少带一个签名，完全没签名的包
 * 内核直接拒绝执行。加上从网络下载的文件带 `com.apple.quarantine` 标记，
 * Gatekeeper 校验失败时给出的提示是「"Typo" 已损坏，无法打开」——
 * 这句话极具误导性，应用根本没坏，只是没签名。
 *
 * ad-hoc 签名解决的是「能不能跑起来」。它**不能**替代正式签名与公证：
 * 用户首次打开仍会看到 Gatekeeper 拦截，需要右键 → 打开，或者手动去掉
 * quarantine 属性。真正的解法是配置开发者证书 + 公证（docs/design/07 §7），
 * 那是 M6 的发布工程内容。
 *
 * 配了真证书（CSC_LINK）时这个钩子直接让路，交给 electron-builder 正常签名。
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  // 有真证书就别插手
  if (process.env.CSC_LINK || process.env.CSC_NAME) return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )

  console.log(`[after-pack] 未配置证书，对 ${appPath} 施加 ad-hoc 签名`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  })
}
