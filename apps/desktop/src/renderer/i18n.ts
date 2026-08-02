/**
 * 渲染进程的文案入口。
 *
 * ## 为什么是一个可变的模块级单例，而不是层层传下去
 *
 * 面板都在模块顶层就构造好了（大纲、命令面板、文件树），而语言要等
 * `preferences.init()` 从磁盘读回来才知道 —— 构造时传进去的必然是错的那份。
 * 所以 `t` 是一个**转发函数**：它每次调用都问当前的翻译器，
 * 于是「构造时是中文、初始化后变英文」这件事不需要任何人配合。
 *
 * 代价是那些**只在构造时写一次**的文案（面板标题、输入框占位符、aria-label）
 * 不会自己更新。这些由各面板的 `retranslate()` 补，调用点集中在 main.ts
 * 的语言变更处 —— 集中在一处，才有可能不漏。
 *
 * ## 为什么不是「切语言要重启」
 *
 * 那是最省事的做法（VS Code 就这样），但它把一次「我想看看英文长什么样」变成
 * 一次重启。这个应用的面板本来就是每次打开重画的，真正需要补的只有几处静态
 * 文案 —— 不值得为省这几行让用户重启。
 */
import {
  FALLBACK_LOCALE,
  createTranslate,
  resolveLocale,
  type LanguageSetting,
  type LocaleId,
  type MessageKey,
} from '../shared/i18n.js'
import type { MessageParams } from '@mosu/i18n'

let translate = createTranslate(FALLBACK_LOCALE)
let currentId: LocaleId = FALLBACK_LOCALE
const listeners = new Set<() => void>()

/** 翻译一条文案。**每次调用都走当前语言**，可以放心在构造函数里调。 */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(key, params)
}

/** 当前语言的 BCP 47 标签。要用 `Intl.*` 格式化日期数字时传给它。 */
export function currentLocale(): LocaleId {
  return currentId
}

/**
 * 换语言。已经是这个语言时什么都不做，返回 false ——
 * 调用方据此跳过一整轮重绘。
 */
export function applyLanguage(setting: LanguageSetting, systemLocale: string): boolean {
  const resolved = resolveLocale(setting, systemLocale)
  if (resolved === currentId) return false
  currentId = resolved
  translate = createTranslate(resolved)
  document.documentElement.lang = resolved
  for (const listener of listeners) listener()
  return true
}

/** 语言变了就通知一次。用于补那些只在构造时写过的文案。 */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
