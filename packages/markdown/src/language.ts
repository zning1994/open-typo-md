/**
 * Markdown 语言配置（编辑侧解析器）。
 *
 * 见 docs/adr/0003-dual-parser.md：编辑期用 @lezer/markdown（增量、容错、
 * 给出精确字符偏移），语义期（导出、大纲分析）将来用 remark/mdast。
 * 这个文件只负责前者。
 */
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import type { LanguageDescription, LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { GFM, type MarkdownConfig } from '@lezer/markdown'
import { footnoteExtension } from './footnote.js'

/**
 * 方言。
 *
 * M2 起默认 GFM —— 表格、任务列表、删除线、自动链接是今天写 Markdown 的
 * 事实基线，默认关掉只会让人以为「不支持」。`commonmark` 仍然保留，
 * 给需要严格模式的场景（以及回归测试）用。
 *
 * 未启用的语法会按纯文本原样保留 —— 这是原则 P2 的要求，绝不吞内容。
 */
export type MarkdownDialect = 'commonmark' | 'gfm'

/**
 * GFM 的语法扩展集合。
 *
 * 刻意用 `commonmarkLanguage` + 显式 `GFM`，而不是上游现成的
 * `markdownLanguage` —— 后者除 GFM 外还塞了下标、上标、emoji 短代码三样，
 * 而路线图把「高亮 / 上下标」排在 M4 且要求**可开关**。用它就等于提前
 * 把三个没设计过呈现规则的语法偷偷打开，`~x~` 会突然变成下标，
 * 用户既不知道为什么，也关不掉。
 */
const GFM_EXTENSIONS: readonly MarkdownConfig[] = [...GFM, footnoteExtension]

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
  const { dialect = 'gfm', extensions = [], codeLanguages = languages } = options
  return markdown({
    base: commonmarkLanguage,
    extensions: dialect === 'gfm' ? [...GFM_EXTENSIONS, ...extensions] : extensions,
    // Lezer 的混合语言解析：``` 后面写的语言名会被交给对应的解析器，
    // 产出的 token 直接落进现有的 HighlightStyle，不需要第二套渲染路径
    codeLanguages: [...codeLanguages],
    addKeymap: false, // 键位由 @typo/editor 统一管理，避免两处定义打架
  })
}
