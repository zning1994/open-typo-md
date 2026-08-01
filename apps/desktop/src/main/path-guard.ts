/**
 * 路径白名单。
 *
 * 架构 01 §5 的要求：main 不信任 renderer 传来的任何路径。渲染进程一旦被
 * 文档里的恶意 HTML 打穿，第一件事就是读 `~/.ssh/id_rsa`。挡住它的不是
 * contextIsolation（那只挡 API），而是这一层。
 *
 * M0 的授权模型很简单：
 * - 用户通过对话框显式打开/保存的文件 → 授权
 * - 该文件所在目录 → 授权（图片等相对路径资源需要）
 * 工作区概念在 M3 引入，届时整个工作区目录一次性授权。
 */
import { realpath } from 'node:fs/promises'
import path from 'node:path'

/** 已授权的目录（绝对路径、已解析符号链接）。 */
const allowedDirs = new Set<string>()
/** 已授权的单个文件。 */
const allowedFiles = new Set<string>()

function normalize(target: string): string {
  return path.resolve(target)
}

/** 把某个文件及其所在目录加入白名单。用户通过对话框选择文件时调用。 */
export async function grantFile(target: string): Promise<void> {
  const abs = normalize(target)
  allowedFiles.add(abs)
  allowedDirs.add(path.dirname(abs))
  // 符号链接指向别处时，真实路径也要授权，否则后续校验会拒绝自己刚开的文件
  try {
    const real = await realpath(abs)
    if (real !== abs) {
      allowedFiles.add(real)
      allowedDirs.add(path.dirname(real))
    }
  } catch {
    // 文件还不存在（另存为的目标），此时只授权目录即可
  }
}

export function grantDirectory(target: string): void {
  allowedDirs.add(normalize(target))
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 校验路径是否已获授权。
 *
 * 校验的是**解析符号链接之后**的真实路径 —— 否则在已授权目录里放一个指向
 * `/etc/passwd` 的符号链接就能绕过白名单。
 */
export async function assertAllowed(target: string): Promise<string> {
  const abs = normalize(target)

  let real = abs
  try {
    real = await realpath(abs)
  } catch {
    // 目标不存在（新建文件）：退而校验其父目录的真实路径
    try {
      real = path.join(await realpath(path.dirname(abs)), path.basename(abs))
    } catch {
      throw new Error(`路径不可访问：${target}`)
    }
  }

  if (allowedFiles.has(real) || allowedFiles.has(abs)) return real
  for (const dir of allowedDirs) {
    if (isInside(dir, real)) return real
  }
  throw new Error(`路径未获授权：${target}`)
}

/** 仅供测试：清空白名单。 */
export function resetGrantsForTest(): void {
  allowedDirs.clear()
  allowedFiles.clear()
}

/** 仅供测试：查看当前授权状态。 */
export function grantsForTest(): { dirs: string[]; files: string[] } {
  return { dirs: [...allowedDirs], files: [...allowedFiles] }
}
