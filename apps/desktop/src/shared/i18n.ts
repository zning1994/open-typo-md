/**
 * 应用文案的装配点 —— main 与渲染进程共用（所以在 `shared/`）。
 *
 * ## 为什么两个进程各建一份翻译器，而不是把翻译好的字符串传过去
 *
 * 原生菜单在 main 侧，面板与对话框在渲染侧，两边的文案在**同一时刻**都要能取到。
 * 如果只在渲染侧翻译再 IPC 送过去，菜单就得等第一个窗口就绪才有标题；
 * 而 macOS 上应用菜单在没有窗口时也存在。文案是纯数据，两边各建一份不花钱。
 *
 * ## 语言从哪来
 *
 * 优先级：用户设置（`ui.language`）→ 系统区域（`app.getLocale()`）→ 兜底英文。
 * 兜底选**英文而不是中文**：一个既不会中文、系统区域也没匹配上的用户，
 * 看到英文至少还能操作。
 *
 * ## 为什么繁体中文不自动退到简体
 *
 * `matchLocale` 只做「完整标签 → 主语言」两级匹配，而我们没有 `zh-TW`，
 * 所以繁体用户会退到英文。这是有意的：给繁体用户看简体是一种「看着像支持了
 * 其实没有」的状态，不如老实退到英文，等真有人来提交那份翻译。
 */
import { createTranslator, matchLocale, type Translator } from '@mosu/i18n'
import { zhCN } from './messages/zh-CN.js'
import { en } from './messages/en.js'
import { ja } from './messages/ja.js'

/** 文案的键表，由源语言（简体中文）决定。 */
export type MessageKey = keyof typeof zhCN

/**
 * 一份完整的语言包。
 *
 * `Record<MessageKey, string>` 而不是 `Partial` —— 漏一条就是**编译错误**。
 * 运行期的降级（见 `@mosu/i18n` 的 `createTranslator`）是给将来的用户 / 插件
 * 语言包准备的，内置这三份不该用到它。
 */
export type Messages = Record<MessageKey, string>

/** 界面语言。加一种语言 = 加一个条目 + 一份 `messages/xx.ts`。 */
export const LOCALES = [
  { id: 'zh-CN', label: '简体中文', messages: zhCN as Messages },
  { id: 'en', label: 'English', messages: en },
  { id: 'ja', label: '日本語', messages: ja },
] as const

export type LocaleId = (typeof LOCALES)[number]['id']

/** 语言设置的可选值。`auto` = 跟随系统。 */
export type LanguageSetting = 'auto' | LocaleId

/** 存进 `settings.json` 的键名。 */
export const LANGUAGE_KEY = 'ui.language'

/** 兜底语言。见文件头「为什么是英文」。 */
export const FALLBACK_LOCALE: LocaleId = 'en'

const IDS = LOCALES.map((l) => l.id)

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === 'auto' || (typeof value === 'string' && (IDS as string[]).includes(value))
}

/** 把「设置值 + 系统区域」解成一个真实存在的语言 id。 */
export function resolveLocale(setting: LanguageSetting, systemLocale: string): LocaleId {
  if (setting !== 'auto') return setting
  return matchLocale(systemLocale, IDS, FALLBACK_LOCALE) as LocaleId
}

export type Translate = Translator<MessageKey>

/**
 * 造这个语言的翻译函数。
 *
 * 兜底目录固定用英文而不是源语言中文：走到兜底说明目标语言缺了这一条，
 * 此时给英文读者一句中文，比给他英文更糟。
 */
export function createTranslate(locale: LocaleId): Translate {
  const found = LOCALES.find((l) => l.id === locale) ?? LOCALES[1]
  return createTranslator<MessageKey>(found.id, found.messages, en)
}
