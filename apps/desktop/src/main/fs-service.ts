/**
 * 文件读写服务（main 进程）。
 *
 * docs/design/04 的核心承诺都落在这个文件里：原子保存、冲突检测、编码保真。
 * 编辑器丢用户的字，一次就足以毁掉信任 —— 所以这里宁可多做校验、多报错，
 * 也绝不「尽力而为地覆盖」。
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { open as openFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  ConflictError,
  type ReadResult,
  type WriteOptions,
  type WriteResult,
} from '@mosu/plugin-api'
import { decodeText, encodeText } from '@mosu/markdown/text'
import { firstHeading } from '@mosu/markdown'
import { assertAllowed } from './path-guard.js'
import { noteSelfWrite } from './watcher.js'
import { FALLBACK_LOCALE, createTranslate, type Translate } from '../shared/i18n.js'

/**
 * 出错文案的默认值。
 *
 * 这一层**不去问当前语言**：它是纯文件操作，问语言就要认识 `electron`
 * （`app.getLocale`）和设置存储，于是「在临时目录上跑真实 fs」的那批防灾测试
 * 就得先把整个 Electron 桩起来 —— 为一句错误消息付这个代价不值当。
 *
 * 真实调用由 IPC 那一侧把当前语言的翻译器传进来（见 index.ts）。
 */
const DEFAULT_T = createTranslate(FALLBACK_LOCALE)

/** 超过这个体积拒绝以编辑器打开（docs/design/04 §8）。 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function isWritable(target: string): Promise<boolean> {
  try {
    await access(target, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function readTextFile(
  target: string,
  t: Translate = DEFAULT_T,
): Promise<ReadResult> {
  const real = await assertAllowed(target)
  const info = await stat(real)

  if (!info.isFile()) throw new Error(t('error.notAFile', { path: target }))
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(
      t('error.fileTooLarge', {
        size: (info.size / 1024 / 1024).toFixed(1),
        limit: MAX_FILE_BYTES / 1024 / 1024,
      }),
    )
  }

  const bytes = await readFile(real)
  const { text, meta } = decodeText(bytes, target)

  return {
    text,
    meta,
    mtimeMs: info.mtimeMs,
    hash: hashBytes(bytes),
    readOnly: !(await isWritable(real)),
  }
}

/**
 * 只读文件开头，用来找文档标题（issue #36）。
 *
 * 文件树上一屏有几十行，每行都要一个标题。**不能读整份文件** —— 一个仓库里
 * 随便一份几 MB 的日志或数据文件就够把展开目录这件事拖成肉眼可见的卡顿。
 *
 * 64 KB 是「标题一定在里面」和「读起来不心疼」之间的折中：真实文档的标题都在
 * 前几行，front matter 再长也不会到这个量级。
 */
const TITLE_HEAD_BYTES = 64 * 1024

export async function readTitle(target: string): Promise<string | null> {
  const real = await assertAllowed(target)
  const info = await stat(real).catch(() => null)
  if (!info?.isFile()) return null

  const handle = await openFile(real, 'r')
  let text: string
  try {
    const buffer = Buffer.alloc(Math.min(TITLE_HEAD_BYTES, info.size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    // 走 decodeText 而不是直接 toString：BOM 与 UTF-16 由它认，
    // 少了这一层，带 BOM 的文件第一行会以一个不可见字符开头，
    // `# 标题` 于是匹配不上
    const decoded = decodeText(buffer.subarray(0, bytesRead), target)
    text = decoded.text
  } catch {
    // 读不出来（权限、编码不支持）就当没有标题 —— 文件树回退到文件名。
    // 这里报错没有意义：用户只是展开了一个目录
    return null
  } finally {
    await handle.close()
  }

  // 截断处可能是半个多字节字符或半行。丢掉最后一行，剩下的一定是完整的 ——
  // 而标题不会正好落在那半行上（真落在了，回退到文件名也不算错）
  if (info.size > TITLE_HEAD_BYTES) {
    const cut = text.lastIndexOf('\n')
    if (cut > 0) text = text.slice(0, cut)
  }

  return firstHeading(text)?.text ?? null
}

/**
 * 原子保存（docs/design/04 §2）。
 *
 *   写同目录临时文件 → fsync → rename
 *
 * 同目录是必须的：跨文件系统的 rename 不是原子操作，会退化成「复制+删除」，
 * 中途断电就得到一个半截文件。
 */
export async function writeTextFile(
  target: string,
  text: string,
  options: WriteOptions,
): Promise<WriteResult> {
  const real = await assertAllowed(target)
  const bytes = encodeText(text, options.meta)

  // 保存前再校验一次基线：磁盘内容自打开以来变过就绝不静默覆盖
  if (options.expectedHash !== null) {
    try {
      const current = hashBytes(await readFile(real))
      if (current !== options.expectedHash) throw new ConflictError(target, current)
    } catch (error) {
      if (error instanceof ConflictError) throw error
      // 文件不存在 —— 说明是新建，继续写
    }
  } else if (options.expectMissing === true) {
    /**
     * 「我以为这个文件已经不在了」。
     *
     * 文件被外部删除之后基线被置为 null（`document.ts` 的
     * `handleExternalChange`），而 null 会跳过上面那段冲突检测 —— 于是文件**又
     * 回来之后**的第一次保存会拿陈旧的缓冲区静默盖掉新内容。
     * `git checkout` 与先删后建的同步客户端都会造出这个时序。
     *
     * 所以在这条路径上单独确认一次：文件真不在就照常新建，
     * 已经回来了就当成冲突交给用户决定 —— 跟正常的冲突走同一个对话框。
     */
    try {
      const current = hashBytes(await readFile(real))
      throw new ConflictError(target, current)
    } catch (error) {
      if (error instanceof ConflictError) throw error
      // 读不到 —— 文件确实不在，继续新建
    }
  }

  // 在**动手写之前**登记，否则文件系统事件会跑在登记前面，
  // 自己的保存被报成外部修改（见 watcher.ts 文件头第 2 条）
  noteSelfWrite(hashBytes(bytes))

  const dir = path.dirname(real)
  const tmp = path.join(dir, `.${path.basename(real)}.tmp-${randomBytes(6).toString('hex')}`)

  let previousMode: number | undefined
  try {
    previousMode = (await stat(real)).mode
  } catch {
    // 新文件，用默认权限
  }

  try {
    const handle = await openFile(tmp, 'w')
    try {
      await handle.writeFile(bytes)
      // fsync：不 sync 的话 rename 可能先于数据落盘，断电后得到一个空文件
      await handle.sync()
    } finally {
      await handle.close()
    }

    if (previousMode !== undefined) await chmod(tmp, previousMode)
    await rename(tmp, real)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }

  const info = await stat(real)
  return { mtimeMs: info.mtimeMs, hash: hashBytes(bytes) }
}

/**
 * 直接覆盖写，不做原子替换。
 *
 * 仅用于原子路径不可用的场景（只读挂载点上的可写文件、某些网络盘）。
 * 调用方必须明确告知用户风险 —— 这条路径断电会丢内容。
 */
export async function writeTextFileNonAtomic(
  target: string,
  text: string,
  options: WriteOptions,
): Promise<WriteResult> {
  const real = await assertAllowed(target)
  const bytes = encodeText(text, options.meta)
  noteSelfWrite(hashBytes(bytes))
  await writeFile(real, bytes)
  const info = await stat(real)
  return { mtimeMs: info.mtimeMs, hash: hashBytes(bytes) }
}

/**
 * 附件（图片）落盘（docs/design/04 §5）。
 *
 * 三条安全约束，每一条都是因为**字节和文件名都来自渲染进程**：
 *
 * 1. **扩展名由 MIME 决定，绝不采信调用方给的文件名。** 否则一个被 XSS 的
 *    渲染进程就能往用户目录里写 `x.sh` / `x.desktop`。
 * 2. **MIME 必须在图片白名单里。** 这个通道的用途只有「粘贴/拖入图片」，
 *    不是通用的写文件能力。
 * 3. **目标目录仍然过 assertAllowed。** 白名单是 main 侧唯一可信的那道门。
 *
 * 命名用内容哈希：同一张图重复粘贴会命中同一个文件，天然去重，
 * 不会在 assets/ 里堆出十几份一模一样的截图。
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
}

/** 附件体积上限。超过它多半是误操作（拖了个视频进来）。 */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

/** 默认附件目录名，M3 引入工作区设置后可配置。 */
const ATTACHMENT_DIR = 'assets'

export async function saveAttachment(
  baseDir: string,
  mime: string,
  bytes: Uint8Array,
  t: Translate = DEFAULT_T,
): Promise<string> {
  const extension = IMAGE_EXTENSIONS[mime.toLowerCase()]
  if (!extension) throw new Error(t('error.imageType', { mime }))
  if (bytes.byteLength === 0) throw new Error(t('error.imageEmpty'))
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      t('error.imageTooLarge', {
        size: (bytes.byteLength / 1024 / 1024).toFixed(1),
        limit: MAX_ATTACHMENT_BYTES / 1024 / 1024,
      }),
    )
  }

  // 校验的是**附件目录本身**而不是 baseDir。两个好处：
  //
  // 1. assertAllowed 是按文件路径设计的 —— 一个已授权目录不算「在自己里面」，
  //    直接拿 baseDir 去问会被自己的白名单拒掉；
  // 2. 更重要的是，assets 若是一个指向白名单之外的符号链接，
  //    这里就当场拒绝，而不是先建目录再发现。
  //
  // 校验通过之后不需要再 grantDirectory：真实路径已经落在某个已授权目录内，
  // 后续资源协议加载走同一套校验自然放行。多授权一次只会白白扩大白名单。
  const dir = await assertAllowed(path.join(baseDir, ATTACHMENT_DIR))
  await mkdir(dir, { recursive: true })

  const name = `${hashBytes(bytes).slice(0, 16)}.${extension}`
  const target = path.join(dir, name)

  // 内容哈希相同即同一张图，已经存在就直接复用
  try {
    await access(target, constants.F_OK)
  } catch {
    await writeFile(target, bytes, { flag: 'wx' }).catch(
      async (error: NodeJS.ErrnoException) => {
        // wx 在并发粘贴同一张图时会 EEXIST —— 那正是我们想要的结果，不算失败
        if (error.code !== 'EEXIST') throw error
      },
    )
  }

  // Markdown 里的路径一律用正斜杠，Windows 上也是
  return `${ATTACHMENT_DIR}/${name}`
}
