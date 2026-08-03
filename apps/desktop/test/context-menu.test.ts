/**
 * 右键菜单的模板（issues #17 / #18）。
 *
 * 弹出本身是 Electron 的事，测不了也不必测。真正会写错的是这里的东西：
 * 菜单里有哪几项、哪些该灰掉、点了回什么 id —— 尤其是**灰掉**那部分，
 * 它依赖调用方传进来的上下文，写反了不会报错，只会让用户点了没反应。
 */
import { describe, expect, it, vi } from 'vitest'
import { contextMenuTemplate, type PathAction } from '../src/shared/context-menu.js'
import { createTranslate } from '../src/shared/i18n.js'
import type { ContextMenuResult } from '../src/shared/channels.js'

const t = createTranslate('zh-CN')

/** 标签集合：labels + 每项的 enabled（undefined 视为可点）。 */
function shape(template: ReturnType<typeof contextMenuTemplate>) {
  return template
    .filter((item) => item.type !== 'separator')
    .map((item) => ({ label: item.label, enabled: item.enabled !== false }))
}

describe('编辑区右键菜单', () => {
  const build = (hasSelection: boolean) =>
    contextMenuTemplate({ kind: 'editor', hasSelection }, t, () => () => undefined)

  it('有选区时该有的项都在，且都可点', () => {
    expect(shape(build(true))).toEqual([
      { label: '剪切', enabled: true },
      { label: '复制', enabled: true },
      { label: '粘贴', enabled: true },
      { label: '粘贴为纯文本', enabled: true },
      { label: '全选', enabled: true },
      { label: '查找选中内容', enabled: true },
    ])
  })

  it('没选区时剪切 / 复制 / 查找选中灰掉，粘贴与全选照旧', () => {
    // 灰掉而不是隐藏：菜单项跳来跳去比灰着更难用
    expect(shape(build(false))).toEqual([
      { label: '剪切', enabled: false },
      { label: '复制', enabled: false },
      { label: '粘贴', enabled: true },
      { label: '粘贴为纯文本', enabled: true },
      { label: '全选', enabled: true },
      { label: '查找选中内容', enabled: false },
    ])
  })

  it('剪切 / 复制 / 粘贴 / 全选走 role，不回渲染进程', () => {
    // 它们由 Electron 直接作用在聚焦的 webContents 上。渲染进程拿不到系统
    // 剪贴板的原始内容（preload 刻意没暴露），自己实现会行为不一致
    const roles = build(true)
      .filter((item) => item.type !== 'separator')
      .map((item) => item.role)
    expect(roles).toEqual([
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'selectAll',
      undefined,
    ])
  })

  it('只有「查找选中内容」会回传 id', () => {
    let picked: ContextMenuResult = null
    const template = contextMenuTemplate(
      { kind: 'editor', hasSelection: true },
      t,
      (r) => () => {
        picked = r
      },
    )
    const find = template.find((item) => item.label === '查找选中内容')
    ;(find?.click as unknown as () => void)()
    expect(picked).toBe('editor.findSelection')
  })
})

describe('标签右键菜单', () => {
  const build = (
    options: { path?: string | null; hasOthers?: boolean; hasRight?: boolean } = {},
    onPath?: PathAction,
  ) =>
    contextMenuTemplate(
      {
        kind: 'tab',
        // 不能写 `options.path ?? '/a.md'` —— `null ?? x` 取的是 x，
        // 于是「未命名文档」那两条用例根本没测到 null（第一版就是这么挂的）
        path: 'path' in options ? (options.path ?? null) : '/a.md',
        hasOthers: options.hasOthers ?? true,
        hasRight: options.hasRight ?? true,
      },
      t,
      () => () => undefined,
      onPath,
    )

  it('五项俱全', () => {
    expect(shape(build()).map((item) => item.label)).toEqual([
      '关闭标签页',
      '关闭其他标签页',
      '关闭右侧标签页',
      '复制文件路径',
      '在文件夹中显示',
    ])
  })

  it('只有一个标签时「关闭其他 / 关闭右侧」灰掉', () => {
    const items = shape(build({ hasOthers: false, hasRight: false }))
    expect(items.find((i) => i.label === '关闭其他标签页')?.enabled).toBe(false)
    expect(items.find((i) => i.label === '关闭右侧标签页')?.enabled).toBe(false)
    // 关掉自己永远是可以的
    expect(items.find((i) => i.label === '关闭标签页')?.enabled).toBe(true)
  })

  it('最右边那个标签只灰「关闭右侧」', () => {
    const items = shape(build({ hasOthers: true, hasRight: false }))
    expect(items.find((i) => i.label === '关闭其他标签页')?.enabled).toBe(true)
    expect(items.find((i) => i.label === '关闭右侧标签页')?.enabled).toBe(false)
  })

  it('未命名文档没有路径可复制、可显示，两项都灰掉', () => {
    const items = shape(build({ path: null }))
    expect(items.find((i) => i.label === '复制文件路径')?.enabled).toBe(false)
    expect(items.find((i) => i.label === '在文件夹中显示')?.enabled).toBe(false)
  })

  it('三个关闭项各自回传自己的 id', () => {
    const picked: ContextMenuResult[] = []
    const template = contextMenuTemplate(
      { kind: 'tab', path: '/a.md', hasOthers: true, hasRight: true },
      t,
      (r) => () => picked.push(r),
    )
    for (const label of ['关闭标签页', '关闭其他标签页', '关闭右侧标签页']) {
      ;(template.find((i) => i.label === label)?.click as unknown as () => void)()
    }
    expect(picked).toEqual(['tab.close', 'tab.closeOthers', 'tab.closeRight'])
  })

  it('复制路径与显示不回传 id —— 它们由 main 就地做掉', () => {
    const onPath = vi.fn()
    const template = build({ path: '/dir/a.md' }, onPath)
    for (const label of ['复制文件路径', '在文件夹中显示']) {
      ;(template.find((i) => i.label === label)?.click as unknown as () => void)()
    }
    expect(onPath.mock.calls).toEqual([
      ['copy', '/dir/a.md'],
      ['reveal', '/dir/a.md'],
    ])
  })

  it('未命名文档上点到那两项也不会拿 null 去调 —— 它们本来就是灰的', () => {
    const onPath = vi.fn()
    const template = build({ path: null }, onPath)
    for (const label of ['复制文件路径', '在文件夹中显示']) {
      ;(template.find((i) => i.label === label)?.click as unknown as () => void)()
    }
    expect(onPath).not.toHaveBeenCalled()
  })
})

/**
 * 文件树的右键菜单（issue #36）。
 *
 * 这一组盯的是**工作区根那条分支**。根不能重命名、不能扔进废纸篓 ——
 * main 侧的守卫会拒，但菜单里也必须先不给：让用户点一下再收到一句报错，
 * 是把内部规则当成了交互。
 */
describe('文件树右键菜单', () => {
  const build = (
    entry: 'file' | 'directory',
    isRoot = false,
    onPath?: PathAction,
    pick: (r: ContextMenuResult) => () => void = () => () => undefined,
  ) =>
    contextMenuTemplate({ kind: 'file-tree', path: '/w/a.md', entry, isRoot }, t, pick, onPath)

  it('文件：打开 / 在新标签页打开 + 通用四项', () => {
    expect(shape(build('file')).map((i) => i.label)).toEqual([
      '打开',
      '在新标签页打开',
      '重命名…',
      '移到废纸篓',
      '复制文件路径',
      '在文件夹中显示',
    ])
  })

  it('文件夹：新建那一组取代打开那一组', () => {
    expect(shape(build('directory')).map((i) => i.label)).toEqual([
      '新建 Markdown 文件…',
      '新建文件夹…',
      '重命名…',
      '移到废纸篓',
      '复制文件路径',
      '在文件夹中显示',
    ])
  })

  it('工作区根上没有重命名，也没有移到废纸篓', () => {
    const labels = shape(build('directory', true)).map((i) => i.label)
    expect(labels).not.toContain('重命名…')
    expect(labels).not.toContain('移到废纸篓')
    // 但新建仍然在 —— 根下面建东西是合法的
    expect(labels).toContain('新建 Markdown 文件…')
  })

  it('复制路径 / 在文件夹中显示由 main 就地做掉，不回渲染进程', () => {
    const onPath = vi.fn()
    const pick = vi.fn(() => () => undefined)
    const template = build('file', false, onPath, pick)

    const byLabel = (label: string) => template.find((item) => item.label === label)
    byLabel('复制文件路径')?.click?.(undefined as never, undefined as never, undefined as never)
    byLabel('在文件夹中显示')?.click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    )

    expect(onPath.mock.calls).toEqual([
      ['copy', '/w/a.md'],
      ['reveal', '/w/a.md'],
    ])

    // 会绕回渲染进程的**只有**这四项。
    //
    // `pick` 是在建模板时就被调用的（它返回的是 click 处理器），所以这里
    // 数的是「哪些项走了 pick」，不是「点了哪一项」。复制路径与在文件夹中显示
    // 不在这张表里 —— 它们由 main 就地做掉，路径已经在请求里了
    expect(pick.mock.calls.flat()).toEqual([
      'tree.open',
      'tree.openInNewTab',
      'tree.rename',
      'tree.trash',
    ])
  })
})
