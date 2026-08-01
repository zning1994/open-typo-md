/**
 * 用户偏好（docs/design/05 §4）。
 *
 * ## 为什么不是 schema 驱动的表单引擎
 *
 * M4.5 给「设置界面」的判词是「用 schema 自动生成表单实质上是另起一个项目：
 * 条件显隐、校验、分组、搜索、重置、迁移」。这话没错，但它描述的是一个**有
 * 几十上百项设置的清单** —— 而那个清单现在不存在。让它存在的是**插件**
 * （M5：插件在 manifest 里声明自己的 settings schema）。
 *
 * 所以这里手写：一个类型、一张默认值表、一个逐字段的校验器。等 M5 的插件
 * 真的开始贡献设置项时，通用化才有东西可通用。
 *
 * ## 校验不是可选项
 *
 * `settings.json` 就在用户数据目录里，明摆着让人直接改（这是「不锁定用户数据」
 * 的一部分）。所以读进来的每一个值都可能是任何东西：字符串、null、对象、
 * 或者手滑打成 `"A4 "`。**一个坏值不该让编辑器打不开**，也不该让 PDF 导出
 * 悄悄用一个荒唐的页边距 —— 每个字段各自校验，不合法就退回默认值。
 */
import type { KeyValueStore } from '@typo/plugin-api'

export const PAGE_SIZES = ['A4', 'Letter', 'Legal', 'A3', 'Tabloid'] as const
export type PageSize = (typeof PAGE_SIZES)[number]

export interface Preferences {
  /** 新标签页默认进源码模式。 */
  sourceModeByDefault: boolean
  /** 导出 PDF 的纸张。 */
  pdfPageSize: PageSize
  /** 导出 PDF 用横向。 */
  pdfLandscape: boolean
  /** 导出 PDF 的页边距，英寸。 */
  pdfMarginInch: number
}

export const DEFAULT_PREFERENCES: Preferences = {
  sourceModeByDefault: false,
  pdfPageSize: 'A4',
  pdfLandscape: false,
  // 跟 Word 的默认值接近，打出来不至于顶到纸边
  pdfMarginInch: 0.6,
}

/** 页边距的合理区间。上限按 A4 短边的一半算 —— 再大就没有正文了。 */
const MARGIN_MIN = 0
const MARGIN_MAX = 3

/** 存进 `settings.json` 时的键名。带前缀分组，方便用户自己看懂那个文件。 */
const KEYS: Record<keyof Preferences, string> = {
  sourceModeByDefault: 'editor.sourceModeByDefault',
  pdfPageSize: 'export.pdf.pageSize',
  pdfLandscape: 'export.pdf.landscape',
  pdfMarginInch: 'export.pdf.marginInch',
}

/**
 * 逐字段校验。
 *
 * 每个字段一个函数而不是一张 schema：字段就这么几个，而手写的校验器能说清楚
 * **为什么**这个范围是这个范围（见页边距那条），schema 说不清。
 */
const VALIDATORS: {
  [K in keyof Preferences]: (value: unknown) => Preferences[K] | null
} = {
  sourceModeByDefault: (value) => (typeof value === 'boolean' ? value : null),
  pdfPageSize: (value) =>
    typeof value === 'string' && (PAGE_SIZES as readonly string[]).includes(value)
      ? (value as PageSize)
      : null,
  pdfLandscape: (value) => (typeof value === 'boolean' ? value : null),
  pdfMarginInch: (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    // 夹住而不是拒绝：用户想要 0 边距或者很宽的边距都是正当需求，
    // 只有超出纸张物理限制的才算错
    return Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, value))
  },
}

export type PreferenceListener = (preferences: Preferences) => void

export class PreferenceStore {
  private values: Preferences = { ...DEFAULT_PREFERENCES }
  private readonly listeners = new Set<PreferenceListener>()

  constructor(private readonly settings: KeyValueStore) {}

  /**
   * 从磁盘读一次。
   *
   * 读不出来 / 读到坏值都退回默认值，**不报错也不提示** ——
   * 设置项是锦上添花，为它挡在启动路径上不值当。
   */
  async init(): Promise<void> {
    const loaded: Partial<Preferences> = {}
    for (const key of Object.keys(KEYS) as (keyof Preferences)[]) {
      const raw = await this.settings.get<unknown>(KEYS[key])
      if (raw === undefined) continue
      const parsed = VALIDATORS[key](raw)
      if (parsed !== null) Object.assign(loaded, { [key]: parsed })
    }
    this.values = { ...DEFAULT_PREFERENCES, ...loaded }
    this.emit()
  }

  all(): Preferences {
    return { ...this.values }
  }

  get<K extends keyof Preferences>(key: K): Preferences[K] {
    return this.values[key]
  }

  /** 写一个值。非法值会被校验器挡下来，此时什么都不做。 */
  async set<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void> {
    const parsed = VALIDATORS[key](value)
    if (parsed === null) return
    if (this.values[key] === parsed) return
    this.values = { ...this.values, [key]: parsed }
    this.emit()
    await this.settings.set(KEYS[key], parsed)
  }

  /** 恢复默认值。逐个写回而不是删键 —— 让用户在 settings.json 里看得见现状。 */
  async reset(): Promise<void> {
    for (const key of Object.keys(KEYS) as (keyof Preferences)[]) {
      await this.set(key, DEFAULT_PREFERENCES[key])
    }
  }

  onChange(listener: PreferenceListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = this.all()
    for (const listener of this.listeners) listener(snapshot)
  }
}
