/**
 * 快捷键绑定的渲染进程一侧（docs/design/05 三 §5）。
 *
 * 表本身在 `shared/keys.ts` —— main 与渲染进程共用同一份，因为**真正生效的
 * 是原生菜单上的加速键**（菜单在 main 侧），而命令面板显示的、编辑器里
 * CodeMirror 认的又各是一份。三份必须来自同一个源。
 *
 * 这个类负责的是「读 / 写 / 通知」，不负责界面 —— 界面在 settings-panel.ts。
 */
import type { KeyValueStore } from '@typo/plugin-api'
import type { MenuCommand } from '../shared/channels.js'
import {
  BINDING_KEY_PREFIX,
  DEFAULT_BINDINGS,
  findConflicts,
  normalizeBinding,
  resolveBindings,
  type BindingMap,
} from '../shared/keys.js'

/** 菜单命令 → 编辑器内核的格式命令 id。只有这几条会落到 CodeMirror 上。 */
export const EDITOR_FORMAT_IDS: Partial<Record<MenuCommand, string>> = {
  'format.bold': 'bold',
  'format.italic': 'italic',
  'format.code': 'code',
  'format.heading.0': 'heading0',
  'format.heading.1': 'heading1',
  'format.heading.2': 'heading2',
  'format.heading.3': 'heading3',
  'format.heading.4': 'heading4',
  'format.heading.5': 'heading5',
  'format.heading.6': 'heading6',
}

export type BindingListener = (bindings: BindingMap) => void

export class KeybindingStore {
  private bindings: BindingMap = { ...DEFAULT_BINDINGS }
  private overrides: Record<string, unknown> = {}
  private readonly listeners = new Set<BindingListener>()

  constructor(private readonly settings: KeyValueStore) {}

  /**
   * 从磁盘读一遍。
   *
   * 只能一个键一个键地问（`KeyValueStore` 没有「列出全部」）——
   * 所以问的是**已知命令的那一批**，用户在 settings.json 里手写一个不存在的
   * 命令名，这里读不到它，也就不会被它影响。这正是想要的。
   */
  async init(commands: readonly MenuCommand[]): Promise<void> {
    const overrides: Record<string, unknown> = {}
    await Promise.all(
      commands.map(async (command) => {
        const key = `${BINDING_KEY_PREFIX}${command}`
        const raw = await this.settings.get<unknown>(key)
        if (raw !== undefined) overrides[key] = raw
      }),
    )
    this.overrides = overrides
    this.bindings = resolveBindings(overrides)
    this.emit()
  }

  all(): BindingMap {
    return { ...this.bindings }
  }

  get(command: MenuCommand): string | undefined {
    return this.bindings[command]
  }

  /** 当前撞在一起的绑定。界面据此给出警告 —— 但不阻止用户保存。 */
  conflicts(): Map<string, MenuCommand[]> {
    return findConflicts(this.bindings)
  }

  /**
   * 改一个绑定。
   *
   * - 传合法的组合 → 绑上去；
   * - 传空串 → **解绑**（这个命令从此没有快捷键）；
   * - 传 null → **恢复默认**（把覆盖从设置里去掉）。
   *
   * 认不出来的组合直接不处理，返回 false 让界面能告诉用户。
   */
  async set(command: MenuCommand, binding: string | null): Promise<boolean> {
    const key = `${BINDING_KEY_PREFIX}${command}`

    if (binding === null) {
      delete this.overrides[key]
      // 存 undefined 等于「删掉这一项」，设置文件里不再有它
      await this.settings.set(key, undefined)
    } else if (binding === '') {
      this.overrides[key] = ''
      await this.settings.set(key, '')
    } else {
      const normalized = normalizeBinding(binding)
      if (!normalized) return false
      this.overrides[key] = normalized
      await this.settings.set(key, normalized)
    }

    this.bindings = resolveBindings(this.overrides)
    this.emit()
    return true
  }

  /** 全部恢复出厂。 */
  async reset(commands: readonly MenuCommand[]): Promise<void> {
    for (const command of commands) await this.set(command, null)
  }

  onChange(listener: BindingListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = this.all()
    for (const listener of this.listeners) listener(snapshot)
  }
}
