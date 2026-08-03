/**
 * 工作区里的文件改动：新建、重命名 / 移动、移到废纸篓（issue #36）。
 *
 * 跟 `fs-service.ts` 分开，因为它们的**信任模型不一样**。那边处理的是「用户
 * 正在编辑的这份文档」，路径来自对话框；这边处理的是「用户在文件树上右键点的
 * 那一行」，而文件树上有什么完全由渲染进程说了算。所以这一层每个入口都走
 * `assertWritableInWorkspace` —— 三条许可里最窄的那条，只认工作区根的子树，
 * 且拒绝根自身（见 path-guard.ts 的说明）。
 *
 * ## 三条共同的规矩
 *
 * 1. **绝不覆盖已有的东西。** 新建用 `wx`、重命名先查目标是否存在。
 *    `fs.rename` 在多数平台上会**静默覆盖**目标文件 —— 用户把 `a.md` 改名成
 *    `b.md` 时若 `b.md` 已存在，他丢的是一份自己都不知道存在的文档。
 * 2. **删除一律走系统废纸篓**（`shell.trashItem`），不用 `unlink`。
 *    废纸篓是可撤销的，`unlink` 不是。拿不到废纸篓（某些 Linux 环境没有实现）
 *    时**报错而不是降级成真删** —— 降级会让「移到废纸篓」这句承诺变成谎话。
 * 3. **文件名要挡住路径分隔符。** 重命名的新名字来自输入框，含 `/` 或 `..`
 *    就成了「移动到任意位置」。守卫那一层能挡住跑出工作区的，但挡不住
 *    「在工作区内乱跑」，而用户敲名字时并没有在表达移动的意思。
 */
import { constants } from 'node:fs'
import { access, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertWritableInWorkspace } from './path-guard.js'
import { FALLBACK_LOCALE, createTranslate, type Translate } from '../shared/i18n.js'

const DEFAULT_T = createTranslate(FALLBACK_LOCALE)

/**
 * 文件名里不能出现的东西。
 *
 * 分隔符和 `..` 的理由见文件头。控制字符与 Windows 保留的那几个符号
 * （`<>:"|?*`）一起挡掉：它们在 NTFS 上直接创建失败，而失败信息是 errno，
 * 用户看不懂。与其让平台去拒绝，不如在这里给一句能读的话。
 */
// 空格和连字符**是合法的**（`我的笔记.md`、`01-引言.md` 都很正常）——
// 别顺手把它们加进这个字符类。这里挡的是控制字符与 Windows 的保留符号
// eslint-disable-next-line no-control-regex
const ILLEGAL_NAME = /[/\\<>:"|?*\u0000-\u001f]/

export function isLegalName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return false
  if (ILLEGAL_NAME.test(trimmed)) return false
  // Windows 上以点或空格结尾的名字会被悄悄截断，于是用户看到的名字和磁盘上的
  // 不是同一个。三个平台一律拒绝，免得同一份工作区换台机器就对不上
  if (/[. ]$/.test(trimmed)) return false
  return true
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 在目录里新建一个空的 Markdown 文件，返回它的路径。
 *
 * 用 `wx`（独占创建）而不是「先查存在再写」：那两步之间有一个窗口，
 * 另一个窗口或别的程序正好在这一瞬间建了同名文件的话，我们会把它清空。
 */
export async function createFile(
  dir: string,
  name: string,
  t: Translate = DEFAULT_T,
): Promise<string> {
  if (!isLegalName(name)) throw new Error(t('error.illegalName', { name }))
  const target = await assertWritableInWorkspace(path.join(dir, name.trim()))
  try {
    await writeFile(target, '', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(t('error.alreadyExists', { name: name.trim() }))
    }
    throw error
  }
  return target
}

/** 新建子目录，返回它的路径。 */
export async function createDirectory(
  dir: string,
  name: string,
  t: Translate = DEFAULT_T,
): Promise<string> {
  if (!isLegalName(name)) throw new Error(t('error.illegalName', { name }))
  const target = await assertWritableInWorkspace(path.join(dir, name.trim()))
  try {
    // 不带 recursive：带上之后目标已存在**不会报错**，于是「新建文件夹」
    // 撞名时悄无声息，用户以为建好了，其实进的是别人的目录
    await mkdir(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(t('error.alreadyExists', { name: name.trim() }))
    }
    throw error
  }
  return target
}

/**
 * 改名（同目录内），返回新路径。
 *
 * **只改名，不移动**：新名字里的分隔符已经被 `isLegalName` 挡掉，落点固定是
 * 原目录。拖拽移动是另一件事，要处理「拖进自己的子目录」这类环，单独做。
 */
export async function renameEntry(
  target: string,
  newName: string,
  t: Translate = DEFAULT_T,
): Promise<string> {
  if (!isLegalName(newName)) throw new Error(t('error.illegalName', { name: newName }))
  const from = await assertWritableInWorkspace(target)
  const to = await assertWritableInWorkspace(path.join(path.dirname(from), newName.trim()))

  if (from === to) return from
  // `fs.rename` 会静默覆盖目标 —— 见文件头第 1 条。
  //
  // 在大小写不敏感的文件系统上（macOS 默认、Windows），`a.md` → `A.md`
  // 会命中这一条：两个名字指向同一个 inode，`exists(to)` 为真。所以先比
  // 真实路径，相等就是同一个文件，那是合法的纯大小写改名，直接放行
  if ((await exists(to)) && (await sameEntry(from, to))) {
    await rename(from, to)
    return to
  }
  if (await exists(to)) throw new Error(t('error.alreadyExists', { name: newName.trim() }))

  await rename(from, to)
  return to
}

/** 两个路径是不是同一个文件系统对象（大小写不敏感的卷上会出现）。 */
async function sameEntry(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([stat(a), stat(b)])
    return x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
  }
}

/**
 * 移到系统废纸篓。
 *
 * 拿不到废纸篓时**报错**，不降级成 `unlink` —— 见文件头第 2 条。
 */
export async function trashEntry(target: string, t: Translate = DEFAULT_T): Promise<void> {
  const real = await assertWritableInWorkspace(target)
  try {
    // electron **在函数里**引入，不在模块顶层。
    //
    // 顶层 import 会让整个模块在 node 环境下加载不了，于是这个文件里真正有
    // 风险的那几条（`rename` 会不会静默覆盖、`mkdir` 撞名会不会无声无息）
    // 就只剩端到端一条路可验 —— 而那正是最该用单测钉死的部分。
    // 换来的代价是这一条本身没有单测，由 e2e 覆盖。
    const { shell } = await import('electron')
    await shell.trashItem(real)
  } catch (error) {
    throw new Error(
      t('error.trashFailed', {
        name: path.basename(real),
        reason: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
