/**
 * 打包后钩子：给未配置证书的 macOS 构建打上**临时签名（ad-hoc）**。
 *
 * 为什么需要：
 * Apple Silicon 要求所有 arm64 可执行文件至少带一个签名，完全没签名的包
 * 内核直接拒绝执行。加上从网络下载的文件带 `com.apple.quarantine` 标记，
 * Gatekeeper 校验失败时给出的提示是「"Typo" 已损坏，无法打开」——
 * 这句话极具误导性，应用根本没坏，只是没签名。
 *
 * ad-hoc 签名解决的**只是「能不能跑起来」**。它解决不了 Gatekeeper：
 * 用户首次打开仍会被拦下，要么右键 → 打开，要么去「系统设置 → 隐私与安全性」
 * 里点「仍要打开」。这一步没有代码层面的绕法 —— **唯一的解法是
 * Developer ID 证书 + 公证**，公证过的包双击即开、一句提示都没有。
 * 拿到证书之后要做什么，见 docs/design/07 §6。
 *
 * 配了真证书（CSC_LINK / CSC_NAME）时这个钩子直接让路，交给 electron-builder
 * 走正常签名 —— 那条路会带上 hardened runtime 与 build/entitlements.mac.plist，
 * 而 ad-hoc 这条不带（也带不了：hardened runtime 要求真实签名）。
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
