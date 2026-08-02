/**
 * 快捷键绑定的唯一真相（docs/design/05 三 §5）。
 *
 * ## 为什么必须先有这个文件
 *
 * 在它之前，同一个绑定写在**三个地方**：`main/menu.ts` 的 `accelerator`、
 * 渲染进程 `MENU_COMMAND_INFO` 里给命令面板显示的那份、以及 `@mosu/editor`
 * 的 CodeMirror keymap。三份格式互不相同（`CmdOrCtrl+Shift+K` / `Mod+Shift+K` /
 * `Mod-Shift-k`），改一处漏两处是必然的 —— 而「让用户能改快捷键」意味着这三份
 * 都要跟着变。所以第一步不是做界面，是把三份合成一份。
 *
 * ## 记法
 *
 * 内部一律用平台无关的 `Mod+Shift+K`：
 *
 * - `Mod` —— macOS 上是 ⌘，其他平台是 Ctrl。**绝大多数绑定该用它**；
 * - `Ctrl` —— 字面的 Control 键，macOS 上也是 Control。只在确实要区分时用
 *   （`Ctrl+Tab` 切标签是跨平台惯例，macOS 上也不该变成 ⌘+Tab —— 那是系统的）；
 * - `Alt`、`Shift` —— 字面。
 *
 * 修饰键的顺序在 `normalize()` 里被规范化，所以 `Shift+Mod+K` 与 `Mod+Shift+K`
 * 是同一个绑定 —— 冲突检测靠字符串相等，顺序不规范会让它漏掉真冲突。
 */
import type { MenuCommand } from './channels.js'

/** 修饰键，**按规范顺序**排列。 */
const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const
type Modifier = (typeof MODIFIERS)[number]

const MODIFIER_ALIASES: Record<string, Modifier> = {
  mod: 'Mod',
  cmd: 'Mod',
  command: 'Mod',
  cmdorctrl: 'Mod',
  commandorcontrol: 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
}

/**
 * 允许当作「主键」的具名键。
 *
 * 刻意是个小集合。放开到「浏览器报什么就是什么」的代价是用户能绑出
 * `Mod+Dead`、`Mod+Unidentified` 这类在别的键盘布局上根本按不出来的组合，
 * 而那种绑定的表现是「设置里明明写着，按下去没反应」。
 */
const NAMED_KEYS = [
  'Tab',
  'Enter',
  'Escape',
  'Space',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Up',
  'Down',
  'Left',
  'Right',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
] as const

const NAMED_LOOKUP = new Map<string, string>(NAMED_KEYS.map((k) => [k.toLowerCase(), k]))

/** 单字符主键里额外放行的标点。`,` 是设置面板的老惯例，`/` 是切源码模式的。 */
const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`'])

export interface ParsedBinding {
  modifiers: Modifier[]
  /** 主键。字母恒为大写，具名键用 `NAMED_KEYS` 里的写法。 */
  key: string
}

/**
 * 解析并规范化一个绑定。认不出来返回 null —— **不猜**。
 *
 * 拒绝「没有修饰键」的绑定：那会把一个普通字符键抢走，用户再也打不出这个字。
 * 唯一的例外是功能键（F1–F12），它们本来就不产生字符。
 */
export function parseBinding(input: string): ParsedBinding | null {
  const parts = input
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const modifiers = new Set<Modifier>()
  let key: string | null = null

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (modifier) {
      modifiers.add(modifier)
      continue
    }
    // 主键只能有一个 —— 出现第二个说明这个串本来就不是一个合法绑定
    if (key !== null) return null

    const named = NAMED_LOOKUP.get(part.toLowerCase())
    if (named) {
      key = named
    } else if (part.length === 1 && (/[a-z\d]/i.test(part) || PUNCTUATION.has(part))) {
      key = /[a-z]/i.test(part) ? part.toUpperCase() : part
    } else {
      return null
    }
  }

  if (key === null) return null

  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key)
  if (modifiers.size === 0 && !isFunctionKey) return null

  // `Mod` 与 `Ctrl` 同时出现在非 mac 平台上是同一个键，绑了也按不出来
  if (modifiers.has('Mod') && modifiers.has('Ctrl')) return null

  return { modifiers: MODIFIERS.filter((m) => modifiers.has(m)), key }
}

/** 规范化成标准写法；认不出来返回 null。 */
export function normalizeBinding(input: string): string | null {
  const parsed = parseBinding(input)
  return parsed ? [...parsed.modifiers, parsed.key].join('+') : null
}

/** Electron 的 accelerator 写法。 */
export function toAccelerator(binding: string): string | null {
  const parsed = parseBinding(binding)
  if (!parsed) return null
  const modifiers = parsed.modifiers.map((m) =>
    m === 'Mod' ? 'CmdOrCtrl' : m === 'Ctrl' ? 'Control' : m,
  )
  return [...modifiers, parsed.key].join('+')
}

/**
 * CodeMirror 的 keymap 写法。
 *
 * 字母要**小写**：CodeMirror 里大写字母表示「按住 Shift 打出来的那个字符」，
 * 写成 `Mod-B` 等于要求用户按 ⌘⇧B。修饰键靠 `Shift-` 显式表达，不靠大小写。
 */
export function toCodeMirrorKey(binding: string): string | null {
  const parsed = parseBinding(binding)
  if (!parsed) return null
  const key = /^[A-Z]$/.test(parsed.key) ? parsed.key.toLowerCase() : parsed.key
  return [...parsed.modifiers, key].join('-')
}

/** 渲染成当前平台上用户看到的样子。 */
export function formatBinding(binding: string, mac: boolean): string {
  const parsed = parseBinding(binding)
  if (!parsed) return binding
  const symbols = parsed.modifiers.map((m) => {
    if (m === 'Mod') return mac ? '⌘' : 'Ctrl'
    if (m === 'Ctrl') return mac ? '⌃' : 'Ctrl'
    if (m === 'Alt') return mac ? '⌥' : 'Alt'
    return mac ? '⇧' : 'Shift'
  })
  return [...symbols, parsed.key].join(mac ? '' : '+')
}

/**
 * 出厂绑定。
 *
 * 没列进来的命令就是**默认没有快捷键** —— 用命令面板或菜单触发。
 * 用户可以给它们绑一个，那正是这张表要能被覆盖的原因。
 */
export const DEFAULT_BINDINGS: Partial<Record<MenuCommand, string>> = {
  'file.open': 'Mod+O',
  'file.openInNewWindow': 'Mod+Shift+O',
  'file.save': 'Mod+S',
  // ⌘⌥S 而不是 ⌘⇧S：后者在绝大多数应用里是「另存为」，抢过来会让肌肉记忆
  // 在这里失灵，而失灵的后果是把文件存到了别处
  'file.saveAll': 'Mod+Alt+S',
  'file.saveAs': 'Mod+Shift+S',
  'file.newTab': 'Mod+T',
  'file.closeTab': 'Mod+W',
  'file.openFolder': 'Mod+Shift+K',
  'view.toggleFiles': 'Mod+Shift+B',
  // 切标签在所有平台上都是 Ctrl+Tab，macOS 上也不变成 ⌘ —— ⌘Tab 是系统的
  'view.nextTab': 'Ctrl+Tab',
  'view.prevTab': 'Ctrl+Shift+Tab',
  'view.toggleSource': 'Mod+/',
  // 专注 / 打字机走功能键：⌘ 打头的两键组合已经被格式命令占满了，
  // 而这两个模式是「开一次写一小时」的东西，不需要顺手到那个程度
  'view.toggleFocus': 'F8',
  'view.toggleTypewriter': 'F9',
  'view.toggleOutline': 'Mod+Shift+E',
  'view.commandPalette': 'Mod+Shift+P',
  'view.settings': 'Mod+,',
  'edit.find': 'Mod+F',
  'format.bold': 'Mod+B',
  'format.italic': 'Mod+I',
  'format.code': 'Mod+E',
  'format.heading.0': 'Mod+0',
  'format.heading.1': 'Mod+1',
  'format.heading.2': 'Mod+2',
  'format.heading.3': 'Mod+3',
  'format.heading.4': 'Mod+4',
  'format.heading.5': 'Mod+5',
  'format.heading.6': 'Mod+6',
}

/** 存进 `settings.json` 时的键名前缀。 */
export const BINDING_KEY_PREFIX = 'keys.'

export type BindingMap = Partial<Record<MenuCommand, string>>

/**
 * 找出撞在一起的绑定。
 *
 * 返回「绑定 → 用了它的命令」，只含真正撞车的那些。
 *
 * 注意**不比较 `Mod` 与 `Ctrl`**：它们在 macOS 上是两个键，在其他平台上是同
 * 一个。要在这里判平台就得让这个纯函数知道自己跑在哪儿，而 `parseBinding`
 * 已经挡掉了同一个绑定里 `Mod` 与 `Ctrl` 并存的情况，剩下的跨平台重合是
 * 用户显式绑出来的，交给他自己负责。
 */
export function findConflicts(bindings: BindingMap): Map<string, MenuCommand[]> {
  const byBinding = new Map<string, MenuCommand[]>()
  for (const [command, binding] of Object.entries(bindings) as [MenuCommand, string][]) {
    const normalized = normalizeBinding(binding)
    if (!normalized) continue
    const list = byBinding.get(normalized)
    if (list) list.push(command)
    else byBinding.set(normalized, [command])
  }
  for (const [binding, commands] of byBinding) {
    if (commands.length < 2) byBinding.delete(binding)
  }
  return byBinding
}

/**
 * 出厂绑定 + 用户覆盖。
 *
 * 覆盖值里的**空串表示「解绑」**，不是「回到默认」—— 那两件事用户都要做得到，
 * 而「回到默认」是把这个键从设置里删掉。
 */
export function resolveBindings(overrides: Record<string, unknown>): BindingMap {
  const resolved: BindingMap = { ...DEFAULT_BINDINGS }
  for (const [key, raw] of Object.entries(overrides)) {
    if (!key.startsWith(BINDING_KEY_PREFIX)) continue
    const command = key.slice(BINDING_KEY_PREFIX.length) as MenuCommand
    if (typeof raw !== 'string') continue
    if (raw === '') {
      delete resolved[command]
      continue
    }
    const normalized = normalizeBinding(raw)
    // 坏值只作废它自己，退回该命令的默认绑定（05 三 §2 的三条规则之一）
    if (normalized) resolved[command] = normalized
  }
  return resolved
}
