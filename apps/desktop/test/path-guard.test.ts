/**
 * 路径白名单（架构 01 §5）。
 *
 * 这是渲染进程被打穿之后唯一还站着的一道墙，所以它的边界值得逐条钉死 ——
 * 尤其是「读文件」和「列目录」这两条**故意分开**的许可。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertAllowed,
  assertAllowedDirectory,
  grantDirectory,
  grantFile,
  resetGrantsForTest,
} from '../src/main/path-guard.js'

let root: string

beforeEach(async () => {
  resetGrantsForTest()
  root = await mkdtemp(path.join(tmpdir(), 'mosu-guard-'))
})

afterEach(async () => {
  resetGrantsForTest()
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

const at = (...parts: string[]) => path.join(root, ...parts)

describe('读文件的许可', () => {
  it('没授权过的一律拒绝', async () => {
    await writeFile(at('a.md'), 'x', 'utf8')
    await expect(assertAllowed(at('a.md'))).rejects.toThrow('未获授权')
  })

  it('显式打开过的文件、以及它旁边的文件都放行', async () => {
    await writeFile(at('a.md'), 'x', 'utf8')
    await writeFile(at('b.png'), 'x', 'utf8')
    await grantFile(at('a.md'))

    await expect(assertAllowed(at('a.md'))).resolves.toContain('a.md')
    // 相对路径的图片要能加载，所以同目录放行
    await expect(assertAllowed(at('b.png'))).resolves.toContain('b.png')
  })

  it('工作区里的文件放行', async () => {
    await mkdir(at('sub'))
    await writeFile(at('sub', 'c.md'), 'x', 'utf8')
    await grantDirectory(root)

    await expect(assertAllowed(at('sub', 'c.md'))).resolves.toContain('c.md')
  })

  it('已授权目录里指向外面的符号链接挡得住 —— 校验的是解析之后的真实路径', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'mosu-outside-'))
    try {
      await writeFile(path.join(outside, 'secret'), 'x', 'utf8')
      await grantDirectory(root)
      await symlink(path.join(outside, 'secret'), at('link'))

      await expect(assertAllowed(at('link'))).rejects.toThrow('未获授权')
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})

describe('列目录的许可', () => {
  it('用户显式打开的工作区，根自身就能列', async () => {
    await grantDirectory(root)
    await expect(assertAllowedDirectory(root)).resolves.toBe(root)
  })

  it('工作区的子目录也能列', async () => {
    await mkdir(at('sub'))
    await grantDirectory(root)
    await expect(assertAllowedDirectory(at('sub'))).resolves.toContain('sub')
  })

  it('只打开过一个文件时，它所在的目录**不能列**', async () => {
    // 这是两条许可分开的全部理由：授权那个目录的本意只是「让这篇文档的
    // 相对路径图片能加载」，不该顺带把「那个目录里还有什么别的文件」也交出去
    await writeFile(at('a.md'), 'x', 'utf8')
    await grantFile(at('a.md'))

    await expect(assertAllowed(at('a.md'))).resolves.toContain('a.md')
    await expect(assertAllowedDirectory(root)).rejects.toThrow('未获授权')
  })

  it('没授权过的目录一律拒绝', async () => {
    await expect(assertAllowedDirectory(root)).rejects.toThrow('未获授权')
  })

  it('不存在的目录报「不可访问」而不是「未授权」—— 两件事不该混为一谈', async () => {
    await grantDirectory(root)
    await expect(assertAllowedDirectory(at('nope'))).rejects.toThrow('不可访问')
  })

  it('工作区里指向外面的符号链接目录挡得住', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'mosu-outside-'))
    try {
      await grantDirectory(root)
      await symlink(outside, at('link'), 'dir')
      await expect(assertAllowedDirectory(at('link'))).rejects.toThrow('未获授权')
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
