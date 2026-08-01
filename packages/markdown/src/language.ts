/**
 * Markdown 语言配置（编辑侧解析器）。
 *
 * 见 docs/adr/0003-dual-parser.md：编辑期用 @lezer/markdown（增量、容错、
 * 给出精确字符偏移），语义期（导出、大纲分析）将来用 remark/mdast。
 * 这个文件只负责前者。
 */
import { commonmarkLanguage, markdown, markdownLanguage } from '@codemirror/lang-markdown'
import type { LanguageDescription, LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
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
  /**
   * 围栏代码块的语言解析器。
   *
   * 默认接入 `@codemirror/language-data` 的全集：约百种语言，每种都是
   * **动态 import**，用到才加载，主 bundle 不受影响（见 docs/design/03 §7）。
   * 传 `[]` 可以完全关掉（大文档降级、或体积敏感的宿主）。
   */
  codeLanguages?: readonly LanguageDescription[]
}

export function markdownLanguageSupport(
  options: MarkdownLanguageOptions = {},
): LanguageSupport {
  const { dialect = 'commonmark', extensions = [], codeLanguages = languages } = options
  return markdown({
    base: dialect === 'gfm' ? markdownLanguage : commonmarkLanguage,
    extensions,
    // Lezer 的混合语言解析：``` 后面写的语言名会被交给对应的解析器，
    // 产出的 token 直接落进现有的 HighlightStyle，不需要第二套渲染路径
    codeLanguages: [...codeLanguages],
    addKeymap: false, // 键位由 @typo/editor 统一管理，避免两处定义打架
  })
}
