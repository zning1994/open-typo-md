/**
 * 文件读写服务（main 进程）。
 *
 * docs/design/04 的核心承诺都落在这个文件里：原子保存、冲突检测、编码保真。
 * 编辑器丢用户的字，一次就足以毁掉信任 —— 所以这里宁可多做校验、多报错，
 * 也绝不「尽力而为地覆盖」。
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { open as openFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  ConflictError,
  type ReadResult,
  type WriteOptions,
  type WriteResult,
} from '@typo/plugin-api'
import { decodeText, encodeText } from '@typo/markdown/text'
import { assertAllowed } from './path-guard.js'

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

export async function readTextFile(target: string): Promise<ReadResult> {
  const real = await assertAllowed(target)
  const info = await stat(real)

  if (!info.isFile()) throw new Error(`不是一个文件：${target}`)
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(
      `文件过大（${(info.size / 1024 / 1024).toFixed(1)} MB），超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限`,
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
  }

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
  await writeFile(real, bytes)
  const info = await stat(real)
  return { mtimeMs: info.mtimeMs, hash: hashBytes(bytes) }
}
