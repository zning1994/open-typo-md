/**
 * 文档控制器测试 —— 全部跑在内存 HostBridge 上，不启动 Electron。
 *
 * 这正是架构 01 §4 里 HostBridge 抽象要换来的东西：打开/保存/冲突这类
 * 最容易出数据丢失事故的逻辑，可以毫秒级地反复验证。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHost, type MemoryHost } from '@typo/plugin-api/testing'
import { DocumentController, type EditorHandle } from '../src/renderer/document.js'
// 断言用**文案表里的那一条**，不写死字面量。这不是同义反复：真正要验的是
// 「这个条件触发的是这一条消息」，而写死字面量的话任何一次改文案（哪怕只是
// 把句号换成问号）都会让测试变红，而那不是 bug。
// 默认语言是英文，见 shared/i18n.ts 的兜底选择。
import { en } from '../src/shared/messages/en.js'

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
    expect(host.dialogLog.some((entry) => entry.includes(en['doc.mixedEol.title']))).toBe(true)
  })

  it('打开失败时报错，不留下半截状态', async () => {
    await controller.openPath('/w/missing.md')
    expect(
      host.dialogLog.some((entry) => entry.startsWith(`message:${en['doc.openFailed.title']}`)),
    ).toBe(true)
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
    expect(host.dialogLog.some((e) => e.includes(en['doc.conflict.title']))).toBe(true)
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
    expect(host.dialogLog.some((e) => e.includes(en['doc.readonly.title']))).toBe(true)
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

describe('外部修改（docs/design/04 §3）', () => {
  /** 打开一个已存在的文件，返回它当前的磁盘 hash。 */
  async function openSeeded(text = '磁盘原内容'): Promise<string> {
    host.seed('/a.md', text)
    await controller.openPath('/a.md')
    return (await host.fs.read('/a.md')).hash
  }

  it('没有未保存改动时直接重载，不打扰用户', async () => {
    // git checkout、外部格式化、云盘同步都走这条路。没有任何东西会丢，就不该问
    await openSeeded()
    host.externalEdit('/a.md', '别的程序写的新内容')
    const changed = (await host.fs.read('/a.md')).hash

    const dialogsBefore = host.dialogLog.length
    await controller.handleExternalChange(changed, false)

    expect(editor.getDoc()).toBe('别的程序写的新内容')
    expect(host.dialogLog.length).toBe(dialogsBefore)
    expect(controller.isDirty()).toBe(false)
  })

  it('重载走 replaceDoc 而不是 setDoc —— 撤销栈和光标位置得留着', async () => {
    await openSeeded()
    const before = editor.replaceDocCalls
    host.externalEdit('/a.md', '新内容')
    await controller.handleExternalChange((await host.fs.read('/a.md')).hash, false)

    expect(editor.replaceDocCalls).toBe(before + 1)
  })

  it('有未保存改动时弹框，绝不自动选边', async () => {
    await openSeeded()
    editor.type('我正在写的东西')
    host.externalEdit('/a.md', '别人写的东西')

    host.answerConfirmWith(0) // 保留我的修改
    await controller.handleExternalChange((await host.fs.read('/a.md')).hash, false)

    expect(editor.getDoc()).toContain('我正在写的东西')
    expect(host.dialogLog.some((d) => d.includes('was changed by another program'))).toBe(true)
  })

  it('选「用磁盘上的内容」才覆盖本地', async () => {
    await openSeeded()
    editor.type('我的修改')
    host.externalEdit('/a.md', '磁盘的新内容')

    host.answerConfirmWith(1)
    await controller.handleExternalChange((await host.fs.read('/a.md')).hash, false)

    expect(editor.getDoc()).toBe('磁盘的新内容')
  })

  it('选了「保留我的」之后，保存时仍然会撞上冲突检测', async () => {
    // 这是最后一道防线，不能因为他刚才说了「保留我的」就把它拆掉
    await openSeeded()
    editor.type('我的修改')
    host.externalEdit('/a.md', '磁盘的新内容')

    host.answerConfirmWith(0) // 保留我的
    await controller.handleExternalChange((await host.fs.read('/a.md')).hash, false)

    host.answerConfirmWith(2) // 保存时的冲突框：取消
    const saved = await controller.save()

    expect(saved).toBe(false)
    expect(host.peek('/a.md')).toBe('磁盘的新内容') // 没被静默覆盖
  })

  it('内容没变（touch、改权限）时什么都不做', async () => {
    const hash = await openSeeded()
    const dialogsBefore = host.dialogLog.length
    const setDocBefore = editor.setDocCalls

    await controller.handleExternalChange(hash, false)

    expect(host.dialogLog.length).toBe(dialogsBefore)
    expect(editor.setDocCalls).toBe(setDocBefore)
  })

  it('文件被删除时保住缓冲区内容，只做标记', async () => {
    // 缓冲区里的内容此刻是唯一一份，自动重载会把它抹掉
    await openSeeded()
    editor.type('还没保存的内容')

    await controller.handleExternalChange(null, true)

    expect(editor.getDoc()).toContain('还没保存的内容')
    expect(controller.state().deleted).toBe(true)
  })

  it('被删除之后保存会重新创建文件', async () => {
    await openSeeded('原内容')
    await controller.handleExternalChange(null, true)
    editor.type('补充')

    expect(await controller.save()).toBe(true)
    expect(host.peek('/a.md')).toBe('原内容补充')
    expect(controller.state().deleted).toBe(false)
  })

  it('未命名文档收到事件时不理会', async () => {
    const dialogsBefore = host.dialogLog.length
    await controller.handleExternalChange('随便什么', false)
    expect(host.dialogLog.length).toBe(dialogsBefore)
  })
})

describe('草稿与监听（docs/design/04 §4）', () => {
  interface Recorded {
    watched: Array<string | null>
    drafts: Map<string, string>
    dropped: string[]
  }

  function withEffects(): { recorded: Recorded; controller: DocumentController } {
    const recorded: Recorded = { watched: [], drafts: new Map(), dropped: [] }
    const ctrl = new DocumentController(
      host,
      editor,
      () => undefined,
      {
        async watch(path) {
          recorded.watched.push(path)
        },
        async writeDraft(key, text) {
          recorded.drafts.set(key, text)
        },
        async dropDraft(key) {
          recorded.dropped.push(key)
          recorded.drafts.delete(key)
        },
      },
      'win-1',
    )
    return { recorded, controller: ctrl }
  }

  it('打开文件后开始监听它', async () => {
    const { recorded, controller: ctrl } = withEffects()
    host.seed('/a.md', '内容')
    await ctrl.openPath('/a.md')

    expect(recorded.watched).toEqual(['/a.md'])
  })

  it('新建文档时停止监听', async () => {
    const { recorded, controller: ctrl } = withEffects()
    host.seed('/a.md', '内容')
    await ctrl.openPath('/a.md')
    await ctrl.newFile()

    expect(recorded.watched).toEqual(['/a.md', null])
  })

  it('保存成功后删掉草稿', async () => {
    const { recorded, controller: ctrl } = withEffects()
    host.seed('/a.md', '内容')
    await ctrl.openPath('/a.md')
    editor.type('改动')
    await ctrl.save()

    expect(recorded.dropped).toContain('/a.md')
  })

  it('另存为会把旧草稿一起清掉，并改盯新文件', async () => {
    // 未命名文档的草稿 key 是 `untitled:<窗口>`，跟文件路径不是一个。
    // 漏掉它就会在草稿目录里留下一份永远没人认领的孤儿
    const { recorded, controller: ctrl } = withEffects()
    editor.type('未命名文档的内容')
    host.answerSaveWith('/b.md')

    expect(await ctrl.saveAs()).toBe(true)
    expect(recorded.dropped).toContain('untitled:win-1')
    expect(recorded.watched.at(-1)).toBe('/b.md')
  })

  it('恢复草稿：先按原文件建立基线，再盖上草稿内容', async () => {
    // 直接把草稿当文件内容装进去是错的 —— 基线会等于草稿，
    // 「磁盘上其实还是旧内容」这件事就再也没人知道了
    const { controller: ctrl } = withEffects()
    host.seed('/a.md', '磁盘上的旧内容')

    await ctrl.restoreDraft('崩溃前没保存的内容', '/a.md')

    expect(editor.getDoc()).toBe('崩溃前没保存的内容')
    expect(ctrl.isDirty()).toBe(true) // 相对磁盘是脏的，⌘S 一下就落盘
    expect(host.peek('/a.md')).toBe('磁盘上的旧内容') // 磁盘还没动
  })

  it('原文件已经没了，草稿退化成未命名文档但内容保住', async () => {
    const { controller: ctrl } = withEffects()
    await ctrl.restoreDraft('崩溃前的内容', '/不存在.md')

    expect(editor.getDoc()).toBe('崩溃前的内容')
    expect(ctrl.state().path).toBe(null)
  })
})
