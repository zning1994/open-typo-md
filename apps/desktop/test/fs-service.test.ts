/**
 * 文件服务的「防灾」测试（docs/design/07 §1）。
 *
 * 这些用例对应的都是「一旦出错就是不可挽回的数据丢失」的场景：
 * 静默覆盖、半截文件、越权读取。它们跑在真实文件系统上（临时目录），
 * 因为这一层的价值恰恰在于跟真实 fs 的交互。
 */
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, UnsupportedEncodingError, type TextFileMeta } from '@typo/plugin-api'
import { hashBytes, readTextFile, writeTextFile } from '../src/main/fs-service.js'
import {
  assertAllowed,
  grantDirectory,
  grantFile,
  resetGrantsForTest,
} from '../src/main/path-guard.js'

const META: TextFileMeta = { encoding: 'utf8', eol: 'lf', mixedEol: false }

let dir: string

beforeEach(async () => {
  resetGrantsForTest()
  dir = await mkdtemp(path.join(tmpdir(), 'typo-test-'))
  grantDirectory(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const file = (name: string) => path.join(dir, name)

describe('读取', () => {
  it('读回内容与保真元数据', async () => {
    await writeFile(file('a.md'), '# 标题\n正文\n', 'utf8')
    const result = await readTextFile(file('a.md'))
    expect(result.text).toBe('# 标题\n正文\n')
    expect(result.meta).toEqual({ encoding: 'utf8', eol: 'lf', mixedEol: false })
    expect(result.readOnly).toBe(false)
  })

  it('CRLF 文件的换行风格被记录下来', async () => {
    await writeFile(file('crlf.md'), '一\r\n二\r\n', 'utf8')
    const result = await readTextFile(file('crlf.md'))
    expect(result.meta.eol).toBe('crlf')
    // 缓冲区内一律 \n
    expect(result.text).toBe('一\n二\n')
  })

  it('二进制文件被拒绝而不是读成乱码', async () => {
    await writeFile(file('bin.md'), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x03]))
    await expect(readTextFile(file('bin.md'))).rejects.toThrow(UnsupportedEncodingError)
  })

  it('目录不能被当作文件打开', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(file('subdir'))
    await expect(readTextFile(file('subdir'))).rejects.toThrow(/不是一个文件/)
  })

  it('已授权目录本身也不能被当作文件读取（纵深防御）', async () => {
    await expect(readTextFile(dir)).rejects.toThrow(/未获授权/)
  })
})

describe('原子保存', () => {
  it('写入后内容正确，且不留下临时文件', async () => {
    const target = file('out.md')
    await grantFile(target)
    await writeTextFile(target, '内容\n', { meta: META, expectedHash: null })

    expect(await readFile(target, 'utf8')).toBe('内容\n')
    const { readdir } = await import('node:fs/promises')
    const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('按 meta 还原 CRLF', async () => {
    const target = file('crlf-out.md')
    await grantFile(target)
    await writeTextFile(target, '一\n二\n', {
      meta: { encoding: 'utf8', eol: 'crlf', mixedEol: false },
      expectedHash: null,
    })
    expect(await readFile(target, 'utf8')).toBe('一\r\n二\r\n')
  })

  it('保留原文件的权限位', async () => {
    const target = file('perm.md')
    await writeFile(target, 'x', 'utf8')
    const { chmod } = await import('node:fs/promises')
    await chmod(target, 0o640)
    await grantFile(target)

    const before = (await stat(target)).mode
    const bytes = await readFile(target)
    await writeTextFile(target, 'y', { meta: META, expectedHash: hashBytes(bytes) })
    expect((await stat(target)).mode).toBe(before)
  })

  it('往返一次后字节完全一致（保真闭环）', async () => {
    const original = Buffer.from('# 标题\r\n\r\n正文 **粗体**\r\n')
    const target = file('roundtrip.md')
    await writeFile(target, original)
    await grantFile(target)

    const read = await readTextFile(target)
    await writeTextFile(target, read.text, { meta: read.meta, expectedHash: read.hash })
    expect(await readFile(target)).toEqual(original)
  })
})

describe('冲突检测', () => {
  it('磁盘内容在打开后被改过时拒绝写入', async () => {
    const target = file('conflict.md')
    await writeFile(target, '原始\n', 'utf8')
    await grantFile(target)
    const read = await readTextFile(target)

    // 模拟另一个程序改了这个文件
    await writeFile(target, '别人改的\n', 'utf8')

    await expect(
      writeTextFile(target, '我改的\n', { meta: META, expectedHash: read.hash }),
    ).rejects.toThrow(ConflictError)

    // 关键：磁盘上必须还是别人的内容，没被悄悄盖掉
    expect(await readFile(target, 'utf8')).toBe('别人改的\n')
  })

  it('expectedHash 为 null 表示调用方明确要覆盖', async () => {
    const target = file('force.md')
    await writeFile(target, '原始\n', 'utf8')
    await grantFile(target)
    await writeTextFile(target, '覆盖\n', { meta: META, expectedHash: null })
    expect(await readFile(target, 'utf8')).toBe('覆盖\n')
  })

  it('基线一致时正常写入', async () => {
    const target = file('ok.md')
    await writeFile(target, '原始\n', 'utf8')
    await grantFile(target)
    const read = await readTextFile(target)
    await writeTextFile(target, '新的\n', { meta: META, expectedHash: read.hash })
    expect(await readFile(target, 'utf8')).toBe('新的\n')
  })
})

describe('路径白名单', () => {
  it('未授权路径一律拒绝', async () => {
    resetGrantsForTest()
    await expect(readTextFile('/etc/passwd')).rejects.toThrow(/未获授权/)
  })

  it('授权某个文件会连带授权其所在目录', async () => {
    resetGrantsForTest()
    const target = file('granted.md')
    await writeFile(target, 'x', 'utf8')
    await grantFile(target)
    await expect(assertAllowed(file('sibling.md'))).resolves.toBeTruthy()
  })

  it('指向白名单外部的符号链接不能绕过校验', async () => {
    resetGrantsForTest()
    grantDirectory(dir)
    const outside = await mkdtemp(path.join(tmpdir(), 'typo-outside-'))
    try {
      await writeFile(path.join(outside, 'secret.txt'), '机密', 'utf8')
      const link = file('link.md')
      await symlink(path.join(outside, 'secret.txt'), link)

      // 校验的是解析符号链接之后的真实路径，因此必须拒绝
      await expect(assertAllowed(link)).rejects.toThrow(/未获授权/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('目录穿越（../）被规范化后拦下', async () => {
    resetGrantsForTest()
    grantDirectory(dir)
    await expect(assertAllowed(path.join(dir, '..', '..', 'etc', 'passwd'))).rejects.toThrow(
      /未获授权/,
    )
  })
})
