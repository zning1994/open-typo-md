/**
 * 翻译器。
 *
 * ## 一条铁律：**永远不抛错，永远有东西可显示**
 *
 * 翻译是最容易出现「某个语言少了一条」的地方 —— 加一句中文文案而忘了补英日，
 * 是每个项目都会发生的事。如果查不到就抛错，那个漏掉的字段会以「整个设置面板
 * 打不开」的形式爆出来。所以逐级降级：目标语言 → 兜底语言 → 键名本身。
 *
 * 键名本身是刻意选的最后一档：它至少能让人看出**是哪一条**漏了，
 * 比空白强得多。
 *
 * 编译期还有第二道防线 —— 目录的类型由源语言（简体中文）导出，
 * 其他语言必须是同一张键表，少一条就是类型错误。运行期这套降级是给
 * **热更新的用户翻译**准备的（M5 之后插件可以贡献语言包），那时类型检查够不着。
 */
import { formatMessage, type MessageParams } from './format.js'

/** 一份语言包：键 → ICU 模板。 */
export type Catalog = Readonly<Record<string, string>>

export interface Translator<K extends string = string> {
  /** 当前语言的 BCP 47 标签（`zh-CN` / `en` / `ja`）。 */
  readonly locale: string
  (key: K, params?: MessageParams): string
}

/**
 * 造一个翻译函数。
 *
 * `fallback` 通常传源语言的目录。**不建议传 null** —— 那样漏译会直接显示键名，
 * 而键名对用户是完全无意义的字符串。
 */
export function createTranslator<K extends string = string>(
  locale: string,
  catalog: Catalog,
  fallback: Catalog | null = null,
): Translator<K> {
  const translate = (key: K, params?: MessageParams): string => {
    const template = catalog[key] ?? fallback?.[key]
    if (template === undefined) return key
    return formatMessage(template, params, locale)
  }
  return Object.assign(translate, { locale })
}

/**
 * 从系统区域挑一个我们支持的语言。
 *
 * 按「完整标签 → 主语言」两级匹配：`zh-TW` 找不到时退到 `zh`，`zh` 也没有的话
 * 才用兜底。**不做繁简转换**：给繁体用户看简体是一种「看着像支持了其实没有」的
 * 状态，不如老老实实退到英文，等真有人来提交 `zh-TW`。
 */
export function matchLocale(
  requested: string,
  available: readonly string[],
  fallback: string,
): string {
  const wanted = requested.toLowerCase()
  for (const candidate of available) {
    if (candidate.toLowerCase() === wanted) return candidate
  }
  const primary = wanted.split('-')[0]
  for (const candidate of available) {
    if (candidate.toLowerCase().split('-')[0] === primary) return candidate
  }
  return fallback
}
