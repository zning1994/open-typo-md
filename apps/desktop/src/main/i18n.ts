/**
 * main 侧的文案入口。
 *
 * 抽成一个模块而不是留在 `index.ts` 里，是因为 `fs-service` 也要用它 ——
 * 那些「文件过大」「不支持的图片类型」最终都会显示在对话框里，属于用户文案。
 *
 * ## 每次现算，不缓存
 *
 * 语言可以被设置面板改、被另一个窗口改、被用户直接编辑 `settings.json` 改。
 * 缓存就要处理「什么时候失效」，而重算一次只是查一个键加建一个闭包。
 * 这跟菜单加速键那边是同一个判断（见 index.ts 的 refreshMenu）。
 *
 * ## 哪些字符串**不**在这里翻
 *
 * 协议处理器的 `越界访问` / `未找到`、路径守卫的 `路径未获授权`、草稿写盘失败的
 * console 输出 —— 这些是**诊断信息**，出现即意味着有 bug 或有人在试探，
 * 用户拿它没办法。翻译它们只会让日志在不同机器上长得不一样，反而更难对。
 */
import { app } from 'electron'
import {
  LANGUAGE_KEY,
  createTranslate,
  isLanguageSetting,
  resolveLocale,
} from '../shared/i18n.js'
import type { Translate } from '../shared/i18n.js'
import { getSetting } from './settings.js'

export async function translator(): Promise<Translate> {
  const setting = await getSetting(LANGUAGE_KEY)
  return createTranslate(
    resolveLocale(isLanguageSetting(setting) ? setting : 'auto', app.getLocale()),
  )
}
