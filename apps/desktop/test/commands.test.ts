/**
 * 命令面板的搜索逻辑。
 *
 * 纯函数，不碰 DOM —— 面板本身的交互（焦点、上下键、Esc）由 e2e 覆盖，
 * 那些在 jsdom 里测出来的结论跟真实浏览器未必一致。
 */
import { describe, expect, it } from 'vitest'
import {
  formatBinding,
  fuzzyMatch,
  searchCommands,
  type Command,
} from '../src/renderer/commands.js'

/** 跟 renderer/main.ts 里的构造方式一致：别名默认就是命令 id。 */
const cmd = (id: string, title: string): Command => ({
  id,
  title,
  keywords: id,
  run: () => undefined,
})

describe('fuzzyMatch', () => {
  it('空查询匹配一切', () => {
    expect(fuzzyMatch('', '任意')).toEqual([])
  })

  it('按顺序出现即命中，并给出位置', () => {
    expect(fuzzyMatch('bd', 'abcd')).toEqual([1, 3])
  })

  it('顺序不对不算命中', () => {
    expect(fuzzyMatch('db', 'abcd')).toBe(null)
  })

  it('大小写不敏感', () => {
    expect(fuzzyMatch('AB', 'ab')).toEqual([0, 1])
  })

  it('查询里的空格只当分隔，不参与匹配', () => {
    expect(fuzzyMatch('a b', 'ab')).toEqual([0, 1])
  })

  it('中文照常匹配', () => {
    expect(fuzzyMatch('标题', '一级标题')).toEqual([2, 3])
  })
})

describe('searchCommands', () => {
  const commands = [
    cmd('file.save', '保存'),
    cmd('file.saveAs', '另存为…'),
    cmd('format.bold', '加粗'),
    cmd('view.toggleSource', '切换源码模式'),
  ]

  it('空查询返回全部', () => {
    expect(searchCommands(commands, '')).toHaveLength(commands.length)
  })

  it('按标题匹配', () => {
    const found = searchCommands(commands, '保存')
    expect(found.map((f) => f.command.title)).toContain('保存')
  })

  it('连续命中排在前面', () => {
    // 「存」在「保存」里靠后、在「另存为…」里也靠后，
    // 但「保存」整体更短且命中更靠前
    const found = searchCommands(commands, '保存')
    expect(found[0]?.command.title).toBe('保存')
  })

  it('标题没命中时回落到别名（命令 id）', () => {
    const found = searchCommands(commands, 'bold')
    expect(found.map((f) => f.command.id)).toContain('format.bold')
  })

  it('别名命中不产生标题高亮 —— 高亮位置对不上会很怪', () => {
    const found = searchCommands(commands, 'bold')
    expect(found.find((f) => f.command.id === 'format.bold')?.hits).toEqual([])
  })

  it('什么都匹配不上时返回空', () => {
    expect(searchCommands(commands, 'zzzz')).toEqual([])
  })
})

describe('formatBinding', () => {
  it('macOS 用符号且不带加号', () => {
    expect(formatBinding('Mod+Shift+P', true)).toBe('⌘⇧P')
  })

  it('其他平台用文字加号', () => {
    expect(formatBinding('Mod+Shift+P', false)).toBe('Ctrl+Shift+P')
  })
})
