/**
 * 路径白名单。
 *
 * 架构 01 §5 的要求：main 不信任 renderer 传来的任何路径。渲染进程一旦被
 * 文档里的恶意 HTML 打穿，第一件事就是读 `~/.ssh/id_rsa`。挡住它的不是
 * contextIsolation（那只挡 API），而是这一层。
 *
 * 授权模型：
 * - 用户通过对话框显式打开/保存的文件 → 授权
 * - 该文件所在目录 → 授权（图片等相对路径资源需要）
 * - 用户显式打开的**工作区目录** → 连同整棵子树授权
 *
 * **读文件**和**列目录**是两条不同的许可**（见 `assertAllowedDirectory`）。
 */
import { realpath } from 'node:fs/promises'
import path from 'node:path'

/** 已授权的目录（绝对路径、已解析符号链接）。 */
const allowedDirs = new Set<string>()
/** 已授权的单个文件。 */
const allowedFiles = new Set<string>()
/**
 * 用户显式打开的工作区根目录。
 *
 * 跟 `allowedDirs` 分开：后者还装着「某个被打开文件的所在目录」，
 * 那种授权的本意只是「让这篇文档的相对路径图片能加载」，
 * 不该顺带把那个目录的**文件清单**也交出去。
 */
const workspaceRoots = new Set<string>()

function normalize(target: string): string {
  return path.resolve(target)
}

/**
 * 把某个文件及其所在目录加入白名单。用户通过对话框选择文件时调用。
 *
 * **授权与校验必须用同一套路径解析。** `assertAllowed` 对一个还不存在的文件
 * 走的是「解析它父目录的真实路径，再拼上文件名」，所以这里也必须把**父目录的
 * 真实路径**登记进去 —— 只登记用户看到的那个路径是不够的。
 *
 * 差别在有符号链接的平台上立刻现形：macOS 的 `/var` 指向 `/private/var`，
 * 临时目录全在它下面。「另存为」的目标文件此刻还不存在，于是下面 `realpath(abs)`
 * 进 catch，`/private/var/...` 一次都没被登记 —— 后续任何写入都被自己的墙拦下。
 *
 * 这条曾经被 `dialog:save` 里那句 `grantDirectory(dirname)` 顺带兜住了
 * （`grantDirectory` 会 realpath 目录）。修 issue #7 时把那句删掉是对的 ——
 * 它同时交出了**目录枚举**权 —— 但它身上还挂着这件正事，删了就露出来了。
 * 表现是 macOS / Windows 的 PDF 导出用例红了，而 Linux 全绿（`/tmp` 不是链接）。
 */
export async function grantFile(target: string): Promise<void> {
  const abs = normalize(target)
  allowedFiles.add(abs)
  allowedDirs.add(path.dirname(abs))

  // 文件自己的真实路径：它存在时才解析得出来（符号链接可能指向别的目录）
  try {
    const real = await realpath(abs)
    if (real !== abs) {
      allowedFiles.add(real)
      allowedDirs.add(path.dirname(real))
    }
  } catch {
    // 文件还不存在（另存为的目标）—— 下面那段仍然要跑
  }

  // 父目录的真实路径。**这一段不能放进上面的 catch 里**：即便文件存在，
  // 它自身不是符号链接而**父目录是**的情况照样要覆盖（macOS 的 /var 就是）。
  try {
    const realDir = await realpath(path.dirname(abs))
    allowedDirs.add(realDir)
    allowedFiles.add(path.join(realDir, path.basename(abs)))
  } catch {
    // 目录也不存在：没什么可授权的，校验那一侧自然会拒绝
  }
}

/**
 * 授权一个工作区目录（连同子树）。用户在「打开文件夹」对话框里选中时调用。
 *
 * 真实路径也要一起授权：macOS 上 `/tmp` 是指向 `/private/tmp` 的符号链接，
 * 只授权用户看到的那个路径的话，后续校验（走 realpath）会拒绝自己刚打开的目录。
 */
export async function grantDirectory(target: string): Promise<void> {
  const abs = normalize(target)
  allowedDirs.add(abs)
  workspaceRoots.add(abs)
  try {
    const real = await realpath(abs)
    if (real !== abs) {
      allowedDirs.add(real)
      workspaceRoots.add(real)
    }
  } catch {
    // 目录不存在就什么都不授权 —— 校验那一侧自然会拒绝
  }
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

/**
 * 校验「能不能列出这个目录」。
 *
 * 跟 `assertAllowed` 是两条不同的许可，故意分开：
 *
 * - `assertAllowed` 回答「能不能读这个**文件**」，它接受任何落在已授权目录
 *   **里面**的路径，但不接受目录自身 —— 目录自身不是一份可读的内容。
 * - 这一条回答「能不能看这个目录的**清单**」，它接受工作区根自身及其子目录。
 *
 * 合并成一条会顺带放开一件不该放开的事：用户只打开过某个文件时，
 * `grantFile` 会授权该文件所在目录（为了相对路径图片），
 * 而那不该等于「可以枚举那个目录里还有什么别的文件」。
 */
export async function assertAllowedDirectory(target: string): Promise<string> {
  const abs = normalize(target)
  let real: string
  try {
    real = await realpath(abs)
  } catch {
    throw new Error(`路径不可访问：${target}`)
  }

  if (workspaceRoots.has(real) || workspaceRoots.has(abs)) return real
  for (const root of workspaceRoots) {
    if (isInside(root, real)) return real
  }
  throw new Error(`目录未获授权：${target}`)
}

/**
 * 校验「能不能在工作区里**改动**这个路径」—— 新建、重命名、移到废纸篓（issue #36）。
 *
 * 这是第三条许可，跟前两条都不同，而且必须是最窄的那一条。
 *
 * **为什么不能复用 `assertAllowed`**：它接受任何落在 `allowedDirs` 里面的路径，
 * 而 `allowedDirs` 装着「用户打开过的每个文件的所在目录」—— 那份授权的本意只是
 * 「让这篇文档的相对路径图片能加载」。拿它当写权限用，等于说「你打开过
 * `~/Documents/a.md`，所以渲染进程可以把 `~/Documents` 里任何东西扔进废纸篓」。
 * 读一张图和删一个文件不是一个量级的事。
 *
 * 所以这一条只认**工作区根的子树**：用户显式选过「打开文件夹」的那些目录。
 *
 * **工作区根自身被明确拒绝。** 允许的话，「移到废纸篓」的第一个目标就是用户
 * 刚打开的整个文件夹 —— 一次误点删掉一整个项目。想删工作区去文件管理器删，
 * 那里至少还有一次系统级确认。
 */
export async function assertWritableInWorkspace(target: string): Promise<string> {
  const abs = normalize(target)

  // 目标可能还不存在（新建、重命名的目标名），所以跟 `assertAllowed` 一样
  // 退而解析父目录 —— 但**校验的仍然是解析后的真实路径**，
  // 否则工作区里放一个指向 `~/.ssh` 的符号链接就能把整棵墙绕过去
  let real: string
  try {
    real = await realpath(abs)
  } catch {
    try {
      real = path.join(await realpath(path.dirname(abs)), path.basename(abs))
    } catch {
      throw new Error(`路径不可访问：${target}`)
    }
  }

  // 根自身不可写。注意这里比的是 real 和 abs 两个都要挡：
  // 用户给的路径和它的真实路径都可能正好是某个根
  if (workspaceRoots.has(real) || workspaceRoots.has(abs)) {
    throw new Error(`不能改动工作区根目录：${target}`)
  }

  for (const root of workspaceRoots) {
    if (isInside(root, real)) return real
  }
  throw new Error(`路径未获授权：${target}`)
}

/** 仅供测试：清空白名单。 */
export function resetGrantsForTest(): void {
  allowedDirs.clear()
  allowedFiles.clear()
  workspaceRoots.clear()
}

/** 仅供测试：查看当前授权状态。 */
export function grantsForTest(): { dirs: string[]; files: string[] } {
  return { dirs: [...allowedDirs], files: [...allowedFiles] }
}
