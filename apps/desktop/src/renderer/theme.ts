/**
 * 主题切换（docs/design/05 §1）。
 *
 * 主题本身是纯 CSS（见 themes.css）；这个文件只负责两件事：
 * 记住用户选了哪个，把它挂到 `<html data-typo-theme>` 上。
 *
 * 「跟随系统」是**单独一档**，不是「没设置时的默认行为」。
 * 只在未设置时跟随系统的话，用户手动选过一次就再也回不到跟随状态了 ——
 * 这是个只能靠重装或改配置文件才能脱身的死角。
 *
 * **已知局限**：已经渲染出来的 Mermaid 图不会跟着换配色。mermaid 的主题是
 * 全局配置，切换需要把所有图重渲染一遍；系统主题切换是低频事件，
 * 为它常驻一套失效逻辑不划算。等类名契约（05 §3）落地、图表改由 CSS 变量
 * 着色时会一并解决。
 */
import type { KeyValueStore } from '@typo/plugin-api'

/**
 * 内置主题。**只有 id，没有标签** —— 标签在文案表里（`theme.*`）。
 *
 * 之前 label 写在这儿，切语言时主题下拉框会留在旧语言里。这类「常量表顺手带一个
 * 中文名」是 i18n 最容易漏的地方，因为它看起来完全不像文案。
 */
export const THEMES = [
  { id: 'auto' },
  { id: 'light' },
  { id: 'dark' },
  { id: 'sepia' },
  { id: 'high-contrast' },
  { id: 'github' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

/**
 * 变量契约的完整清单（不带 `--typo-` 前缀）。
 *
 * 跟 themes.css 里 `[data-typo-theme='light']` 那一份**必须一致** ——
 * 导出时按这张表采集当前生效的计算值，漏一个，导出的文件里那一处就会退回
 * 兜底色。放在这里而不是 CSS 里，是因为只有 TS 这边能被别的代码读到。
 */
export const THEME_VARIABLES = [
  'font-body',
  'font-mono',
  'font-size',
  'line-height',
  'content-width',
  'bg',
  'fg',
  'fg-muted',
  'accent',
  'border',
  'border-strong',
  'code-bg',
  'selection',
  'danger',
  'marker-fg',
  'cursor',
  'status-bg',
  'string-fg',
  'number-fg',
  'type-fg',
] as const

const DEFAULT: ThemeId = 'auto'
const SETTING_KEY = 'appearance.theme'

function isTheme(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value)
}

export class ThemeManager {
  private current: ThemeId = DEFAULT

  constructor(private readonly settings: KeyValueStore) {}

  /**
   * 读取已保存的选择并应用。
   *
   * 在此之前 `index.html` 上已经写死了 `data-typo-theme="auto"` ——
   * 不预置的话，从进程启动到这里 await 完成之间会有一段没有任何变量的空窗，
   * 界面先闪一下无样式的白底。
   */
  async init(): Promise<void> {
    const stored = await this.settings.get<string>(SETTING_KEY)
    this.apply(isTheme(stored) ? stored : DEFAULT)
  }

  get theme(): ThemeId {
    return this.current
  }

  async select(theme: ThemeId): Promise<void> {
    this.apply(theme)
    await this.settings.set(SETTING_KEY, theme)
  }

  private apply(theme: ThemeId): void {
    this.current = theme
    document.documentElement.dataset['typoTheme'] = theme
  }
}
