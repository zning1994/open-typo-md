/**
 * 路径白名单（架构 01 §5）。
 *
 * 这是渲染进程被打穿之后唯一还站着的一道墙，所以它的边界值得逐条钉死 ——
 * 尤其是「读文件」和「列目录」这两条**故意分开**的许可。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('授权一个**还不存在**的文件，照样把它所在目录整个放开', async () => {
    // 这不是缺陷，是「另存为」必须的：目标文件此刻还没有。
    // 记在这里是因为它决定了 issue #4 的破坏力 —— `grantFile` 只要被喂进
    // 一个渲染进程编造的路径，连「那个文件得真的存在」这道天然限制都没有。
    await writeFile(at('neighbour'), 'x', 'utf8')
    await grantFile(at('does-not-exist.md'))

    await expect(assertAllowed(at('neighbour'))).resolves.toContain('neighbour')
  })

  it('通过符号链接目录授权一个**还不存在**的文件，之后写它和它的邻居都放行', async () => {
    // macOS 上 `/var` 指向 `/private/var`，而临时目录全在它下面 —— 这条用例
    // 就是那个形状。「另存为」的目标此刻还不存在，于是 `realpath(文件)` 会抛；
    // 如果因此连**父目录的真实路径**也不登记，后续写入会被自己的墙拦下。
    //
    // 这不是假想：修 issue #7 删掉 `dialog:save` 里那句 grantDirectory 之后，
    // macOS 与 Windows 的 PDF 导出用例当场红了，而 Linux 全绿（/tmp 不是链接）。
    const real = await mkdtemp(path.join(tmpdir(), 'mosu-real-'))
    const link = path.join(root, 'via-link')
    try {
      await symlink(real, link, 'dir')
      // 用户在对话框里选的是**链接下面**的一个还不存在的文件
      await grantFile(path.join(link, 'new.pdf'))

      // 用链接路径写它自己
      await expect(assertAllowed(path.join(link, 'new.pdf'))).resolves.toContain('new.pdf')
      // 用真实路径写它自己 —— 校验解析之后拿到的正是这个
      await expect(assertAllowed(path.join(real, 'new.pdf'))).resolves.toContain('new.pdf')
      // 同目录的邻居（导出会连着写好几个文件）
      await expect(assertAllowed(path.join(real, 'other.pdf'))).resolves.toContain('other.pdf')
    } finally {
      await rm(real, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('但目录**枚举**权仍然不给 —— issue #7 守的是这条', async () => {
    // 上一条放开的是「写这个目录里的文件」，不是「看这个目录里有什么」。
    // 两者混在一起正是 issue #7：另存为到 ~/Documents 顺带交出了整个目录清单
    await grantFile(at('saved.md'))
    await expect(assertAllowedDirectory(root)).rejects.toThrow('未获授权')
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

/**
 * 谁有资格授权（issue #4 的回归）。
 *
 * 上面每一条都在验「校验」这一半。但 #4 暴露的是**另一半**：校验再严，只要
 * 授权原语能被渲染进程间接触发，整堵墙就是纸的。当时有两处 `grantFile(target)`
 * ——`window:create` 的 IPC 处理器里一处，`createWindow` 内部一处 —— 而
 * `window:create` 的入参完全由渲染进程决定。喂一个 `~/.ssh/id_rsa` 进去，
 * `~/.ssh` 整棵子树就进了白名单。
 *
 * 所以规则不是「小心点用」，而是**授权只能发生在 index.ts**：那里是进程入口，
 * 对话框结果、命令行参数、`open-file` 事件、会话恢复都在它手上，每一处都能
 * 当场判断路径到底是不是用户选的。别的模块拿不到这个上下文，就不该有这个能力。
 *
 * 这是一条静态规则，所以用静态方式验。行为测试在这里做不到 —— 要把 electron
 * 的 `BrowserWindow`/`ipcMain` 全套搭起来，成本远超它能挡住的东西，
 * 而且搭出来的假货未必和真环境同构。
 */
describe('授权原语的调用面', () => {
  const MAIN = new URL('../src/main/', import.meta.url)

  it('只有 index.ts 能调 grantFile / grantDirectory', async () => {
    const files = (await readdir(MAIN)).filter((name) => name.endsWith('.ts'))
    // path-guard.ts 是定义方，index.ts 是唯一的授权方
    const exempt = new Set(['path-guard.ts', 'index.ts'])

    const offenders: string[] = []
    for (const name of files) {
      if (exempt.has(name)) continue
      const source = await readFile(new URL(name, MAIN), 'utf8')
      // 去掉注释再找：这些文件里有好几段专门在讲「为什么这里不能授权」，
      // 照着文本匹配会把解释当成犯案现场
      if (/\bgrant(File|Directory)\s*\(/.test(stripComments(source))) offenders.push(name)
    }

    expect(offenders).toEqual([])
  })
})

/** 粗略去掉行注释与块注释。够用即可 —— 这里只是给上面那条规则降噪。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}
