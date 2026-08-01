/**
 * 文档控制器测试 —— 全部跑在内存 HostBridge 上，不启动 Electron。
 *
 * 这正是架构 01 §4 里 HostBridge 抽象要换来的东西：打开/保存/冲突这类
 * 最容易出数据丢失事故的逻辑，可以毫秒级地反复验证。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHost, type MemoryHost } from '@typo/plugin-api/testing'
import { DocumentController, type EditorHandle } from '../src/renderer/document.js'

/** 极简的编辑器替身：只实现控制器需要的三个方法。 */
class FakeEditor implements EditorHandle {
  private text = ''
  readOnly = false
  setDocCalls = 0
  replaceDocCalls = 0

  getDoc(): string {
    return this.text
  }
  setDoc(text: string, options: { readOnly?: boolean } = {}): void {
    this.text = text
    this.readOnly = options.readOnly ?? false
    this.setDocCalls++
  }
  replaceDoc(text: string): void {
    this.text = text
    this.replaceDocCalls++
  }
  /** 模拟用户敲字。 */
  type(text: string): void {
    this.text += text
  }
}

let host: MemoryHost
let editor: FakeEditor
let controller: DocumentController

beforeEach(() => {
  host = createMemoryHost()
  editor = new FakeEditor()
  controller = new DocumentController(host, editor, () => undefined)
})

describe('打开', () => {
  it('把内容与保真元数据一起载入', async () => {
    host.seed('/w/a.md', '# 标题\n', { eol: 'crlf' })
    await controller.openPath('/w/a.md')

    expect(editor.getDoc()).toBe('# 标题\n')
    expect(controller.state().name).toBe('a.md')
    expect(controller.state().meta.eol).toBe('crlf')
    expect(controller.state().dirty).toBe(false)
  })

  it('混合换行必须当面提示用户，而不是等保存后才发现', async () => {
    host.seed('/w/mixed.md', 'a\nb\n', { mixedEol: true, eol: 'crlf' })
    await controller.openPath('/w/mixed.md')
    expect(host.dialogLog.some((entry) => entry.includes('混合换行符'))).toBe(true)
  })

  it('打开失败时报错，不留下半截状态', async () => {
    await controller.openPath('/w/missing.md')
    expect(host.dialogLog.some((entry) => entry.startsWith('message:无法打开文件'))).toBe(true)
    expect(controller.state().path).toBe(null)
  })
})

describe('脏标记', () => {
  it('编辑后变脏，保存后变干净', async () => {
    host.seed('/w/a.md', '原文')
    await controller.openPath('/w/a.md')
    expect(controller.isDirty()).toBe(false)

    editor.type('追加')
    expect(controller.isDirty()).toBe(true)

    await controller.save()
    expect(controller.isDirty()).toBe(false)
    expect(host.peek('/w/a.md')).toBe('原文追加')
  })

  it('改回原样后不再算脏', async () => {
    host.seed('/w/a.md', '原文')
    await controller.openPath('/w/a.md')
    editor.type('X')
    expect(controller.isDirty()).toBe(true)
    editor.setDoc('原文')
    expect(controller.isDirty()).toBe(false)
  })
})

describe('保存冲突', () => {
  beforeEach(async () => {
    host.seed('/w/a.md', '原始内容')
    await controller.openPath('/w/a.md')
    editor.setDoc('我的修改')
  })

  it('选择「覆盖」时写入我的版本', async () => {
    host.externalEdit('/w/a.md', '别人的修改')
    host.answerConfirmWith(0)

    expect(await controller.save()).toBe(true)
    expect(host.peek('/w/a.md')).toBe('我的修改')
    expect(controller.isDirty()).toBe(false)
  })

  it('选择「重新载入」时放弃我的版本，但保留撤销栈', async () => {
    host.externalEdit('/w/a.md', '别人的修改')
    host.answerConfirmWith(1)

    expect(await controller.save()).toBe(false)
    expect(editor.getDoc()).toBe('别人的修改')
    // 用 replaceDoc 而不是 setDoc —— 用户还能撤销回自己的版本
    expect(editor.replaceDocCalls).toBe(1)
    expect(host.peek('/w/a.md')).toBe('别人的修改')
  })

  it('选择「取消」时两边都不动', async () => {
    host.externalEdit('/w/a.md', '别人的修改')
    host.answerConfirmWith(2)

    expect(await controller.save()).toBe(false)
    expect(host.peek('/w/a.md')).toBe('别人的修改')
    expect(editor.getDoc()).toBe('我的修改')
  })

  it('绝不静默覆盖：一定弹了对话框', async () => {
    host.externalEdit('/w/a.md', '别人的修改')
    host.answerConfirmWith(2)
    await controller.save()
    expect(host.dialogLog.some((e) => e.includes('文件已被其他程序修改'))).toBe(true)
  })

  it('没有外部修改时直接写入，不打扰用户', async () => {
    expect(await controller.save()).toBe(true)
    expect(host.dialogLog.filter((e) => e.startsWith('confirm:'))).toEqual([])
  })
})

describe('只读文件', () => {
  it('打开只读文件时进入只读模式并提示', async () => {
    host.seed('/w/ro.md', '内容')
    // 内存 host 没有权限概念，直接构造一个只读读取结果
    const originalRead = host.fs.read.bind(host.fs)
    host.fs.read = async (path: string) => ({ ...(await originalRead(path)), readOnly: true })

    await controller.openPath('/w/ro.md')
    expect(controller.state().readOnly).toBe(true)
    expect(host.dialogLog.some((e) => e.includes('只读'))).toBe(true)
  })

  it('只读文件保存被拒绝，不产生写入', async () => {
    host.seed('/w/ro.md', '内容')
    const originalRead = host.fs.read.bind(host.fs)
    host.fs.read = async (path: string) => ({ ...(await originalRead(path)), readOnly: true })
    await controller.openPath('/w/ro.md')

    editor.setDoc('改了')
    expect(await controller.save()).toBe(false)
    expect(host.peek('/w/ro.md')).toBe('内容')
  })
})

describe('未保存内容的拦截', () => {
  it('新建前会询问，选「取消」则不动', async () => {
    host.seed('/w/a.md', '原文')
    await controller.openPath('/w/a.md')
    editor.type('改动')

    host.answerConfirmWith(2) // 取消
    await controller.newFile()
    expect(controller.state().path).toBe('/w/a.md')
    expect(editor.getDoc()).toBe('原文改动')
  })

  it('选「不保存」则丢弃', async () => {
    host.seed('/w/a.md', '原文')
    await controller.openPath('/w/a.md')
    editor.type('改动')

    host.answerConfirmWith(1) // 不保存
    await controller.newFile()
    expect(controller.state().path).toBe(null)
    expect(editor.getDoc()).toBe('')
    expect(host.peek('/w/a.md')).toBe('原文')
  })

  it('选「保存」则先落盘再继续', async () => {
    host.seed('/w/a.md', '原文')
    await controller.openPath('/w/a.md')
    editor.type('改动')

    host.answerConfirmWith(0) // 保存
    await controller.newFile()
    expect(host.peek('/w/a.md')).toBe('原文改动')
    expect(controller.state().path).toBe(null)
  })

  it('内容干净时关闭不打扰用户', async () => {
    host.seed('/w/a.md', '原文')
    await controller.openPath('/w/a.md')
    expect(await controller.canClose()).toBe(true)
    expect(host.dialogLog.filter((e) => e.startsWith('confirm:'))).toEqual([])
  })
})
