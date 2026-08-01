/**
 * 快捷键绑定表（shared/keys.ts）。
 *
 * 这一层是**三份格式的翻译中枢**：Electron 的 accelerator、CodeMirror 的
 * keymap、以及给人看的 ⌘⇧K。翻错一处的表现是「设置里写着、按下去没反应」，
 * 而那种缺陷用户报不清楚，所以规则全部钉在这里。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BINDINGS,
  findConflicts,
  formatBinding,
  normalizeBinding,
  parseBinding,
  resolveBindings,
  toAccelerator,
  toCodeMirrorKey,
} from '../src/shared/keys.js'

describe('解析与规范化', () => {
  it('修饰键顺序被规范化 —— 否则冲突检测靠字符串相等会漏', () => {
    expect(normalizeBinding('Shift+Mod+K')).toBe('Mod+Shift+K')
    expect(normalizeBinding('Mod+Shift+K')).toBe('Mod+Shift+K')
  })

  it('别名归一：Cmd / Command / CmdOrCtrl 都是 Mod', () => {
    expect(normalizeBinding('Cmd+S')).toBe('Mod+S')
    expect(normalizeBinding('CmdOrCtrl+S')).toBe('Mod+S')
    expect(normalizeBinding('Command+S')).toBe('Mod+S')
    expect(normalizeBinding('Option+S')).toBe('Alt+S')
  })

  it('字母恒为大写，具名键用规范写法', () => {
    expect(normalizeBinding('mod+b')).toBe('Mod+B')
    expect(normalizeBinding('ctrl+tab')).toBe('Ctrl+Tab')
    expect(normalizeBinding('mod+pageup')).toBe('Mod+PageUp')
  })

  it('放行少数标点 —— 设置是 Mod+,，源码模式是 Mod+/', () => {
    expect(normalizeBinding('Mod+,')).toBe('Mod+,')
    expect(normalizeBinding('Mod+/')).toBe('Mod+/')
  })

  it('没有修饰键的一律拒绝 —— 那会把一个字符键抢走，用户再也打不出它', () => {
    expect(normalizeBinding('K')).toBeNull()
    expect(normalizeBinding('Tab')).toBeNull()
  })

  it('功能键是例外：它们本来就不产生字符', () => {
    expect(normalizeBinding('F5')).toBe('F5')
    expect(normalizeBinding('Mod+F12')).toBe('Mod+F12')
    expect(normalizeBinding('F13')).toBeNull()
  })

  it('Mod 与 Ctrl 不能同时出现 —— 非 mac 平台上那是同一个键，绑了按不出来', () => {
    expect(normalizeBinding('Mod+Ctrl+K')).toBeNull()
  })

  it('认不出来的一律返回 null，不猜', () => {
    expect(normalizeBinding('')).toBeNull()
    expect(normalizeBinding('Mod+')).toBeNull()
    expect(normalizeBinding('Mod+A+B')).toBeNull()
    expect(normalizeBinding('Mod+Dead')).toBeNull()
    expect(normalizeBinding('Mod+Unidentified')).toBeNull()
  })

  it('解析结果带着规范顺序的修饰键', () => {
    expect(parseBinding('Shift+Alt+Mod+K')).toEqual({
      modifiers: ['Mod', 'Alt', 'Shift'],
      key: 'K',
    })
  })
})

describe('翻译成三种目标格式', () => {
  it('Electron 的 accelerator', () => {
    expect(toAccelerator('Mod+Shift+K')).toBe('CmdOrCtrl+Shift+K')
    expect(toAccelerator('Ctrl+Tab')).toBe('Control+Tab')
    expect(toAccelerator('Mod+,')).toBe('CmdOrCtrl+,')
    expect(toAccelerator('乱写')).toBeNull()
  })

  it('CodeMirror 的 keymap —— 字母必须小写', () => {
    // 大写在 CodeMirror 里表示「按住 Shift 打出来的那个字符」，
    // 写成 Mod-B 等于要求用户按 ⌘⇧B
    expect(toCodeMirrorKey('Mod+B')).toBe('Mod-b')
    expect(toCodeMirrorKey('Mod+Shift+X')).toBe('Mod-Shift-x')
    expect(toCodeMirrorKey('Mod+1')).toBe('Mod-1')
    expect(toCodeMirrorKey('Ctrl+Tab')).toBe('Ctrl-Tab')
  })

  it('给人看的写法分平台', () => {
    expect(formatBinding('Mod+Shift+K', true)).toBe('⌘⇧K')
    expect(formatBinding('Mod+Shift+K', false)).toBe('Ctrl+Shift+K')
    // macOS 上 Mod 与 Ctrl 是两个不同的键，符号也不同
    expect(formatBinding('Ctrl+Tab', true)).toBe('⌃Tab')
    // 认不出来时原样显示，不吞掉（原则 P2）
    expect(formatBinding('乱写', true)).toBe('乱写')
  })
})

describe('冲突检测', () => {
  it('同一个组合被两条命令用上就算冲突', () => {
    const conflicts = findConflicts({ 'file.save': 'Mod+S', 'file.saveAs': 'Mod+S' })
    expect([...conflicts.keys()]).toEqual(['Mod+S'])
    expect(conflicts.get('Mod+S')).toHaveLength(2)
  })

  it('写法不同但其实是同一个组合，照样算冲突', () => {
    const conflicts = findConflicts({
      'file.save': 'Mod+Shift+S',
      'file.saveAs': 'Shift+Cmd+S',
    })
    expect(conflicts.size).toBe(1)
  })

  it('出厂绑定自己不许有冲突', () => {
    expect([...findConflicts(DEFAULT_BINDINGS).keys()]).toEqual([])
  })
})

describe('出厂值 + 用户覆盖', () => {
  it('没有覆盖时就是出厂值', () => {
    expect(resolveBindings({})).toEqual(DEFAULT_BINDINGS)
  })

  it('覆盖生效，并且顺手规范化', () => {
    const resolved = resolveBindings({ 'keys.format.bold': 'shift+cmd+b' })
    expect(resolved['format.bold']).toBe('Mod+Shift+B')
  })

  it('空串是「解绑」，不是「回到默认」', () => {
    const resolved = resolveBindings({ 'keys.format.bold': '' })
    expect(resolved['format.bold']).toBeUndefined()
  })

  it('坏值只作废它自己，别的绑定不受影响', () => {
    // settings.json 就摆在用户数据目录里让人直接改，读进来的每个值都可能是
    // 任何东西。整份绑定因为一个手滑回到出厂状态，比手滑本身糟糕得多
    const resolved = resolveBindings({
      'keys.format.bold': 'Mod+Shift+B',
      'keys.format.italic': { 不是: '字符串' },
      'keys.format.code': 'Mod+乱写+E',
    })
    expect(resolved['format.bold']).toBe('Mod+Shift+B')
    expect(resolved['format.italic']).toBe(DEFAULT_BINDINGS['format.italic'])
    expect(resolved['format.code']).toBe(DEFAULT_BINDINGS['format.code'])
  })

  it('不带前缀的设置项一概不看', () => {
    expect(resolveBindings({ 'editor.sourceModeByDefault': true })).toEqual(DEFAULT_BINDINGS)
  })
})
