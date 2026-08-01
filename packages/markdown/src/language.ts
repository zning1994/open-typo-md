/**
 * Markdown 语言配置（编辑侧解析器）。
 *
 * 见 docs/adr/0003-dual-parser.md：编辑期用 @lezer/markdown（增量、容错、
 * 给出精确字符偏移），语义期（导出、大纲分析）将来用 remark/mdast。
 * 这个文件只负责前者。
 */
import { commonmarkLanguage, markdown, markdownLanguage } from '@codemirror/lang-markdown'
import type { LanguageSupport } from '@codemirror/language'
import type { MarkdownConfig } from '@lezer/markdown'

/**
 * 方言。
 *
 * M1 只做 CommonMark（见 docs/design/08-roadmap.md 的排期理由：
 * 先把基础语法做到零损耗，再铺功能面）。GFM 的解析在 M2 打开，
 * 届时表格、任务列表、删除线的呈现规则一并补上。
 *
 * 未启用的语法会按纯文本原样保留 —— 这是原则 P2 的要求，绝不吞内容。
 */
export type MarkdownDialect = 'commonmark' | 'gfm'

export interface MarkdownLanguageOptions {
  dialect?: MarkdownDialect
  /** 插件注册的语法扩展（三件套中的 Lezer 部分，见 docs/design/03 §2）。 */
  extensions?: MarkdownConfig[]
}

export function markdownLanguageSupport(
  options: MarkdownLanguageOptions = {},
): LanguageSupport {
  const { dialect = 'commonmark', extensions = [] } = options
  return markdown({
    base: dialect === 'gfm' ? markdownLanguage : commonmarkLanguage,
    extensions,
    addKeymap: false, // 键位由 @typo/editor 统一管理，避免两处定义打架
  })
}
