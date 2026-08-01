/**
 * Markdown 语言配置（编辑侧解析器）。
 *
 * 见 docs/adr/0003-dual-parser.md：编辑期用 @lezer/markdown（增量、容错、
 * 给出精确字符偏移），语义期（导出、大纲分析）将来用 remark/mdast。
 * 这个文件只负责前者。
 */
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { GFM, type MarkdownConfig } from '@lezer/markdown'
import { footnoteExtension } from './footnote.js'
import { frontmatterExtension } from './frontmatter.js'

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
  /**
   * YAML front matter（文档开头 `---` 包起来的元数据块）。
   *
   * 默认**开启** —— 静态站点生成器、Obsidian、Hugo 全都用它，关掉的话
   * 文档一开头就是一片没有高亮的纯文本，看着像坏了。
   *
   * 它不是 CommonMark 的一部分（03 §3 要求非 CommonMark 语法的默认开关状态
   * 必须明示），所以留了开关；关掉之后 `---` 会退化成分隔线 + 普通段落，
   * 内容一个字不少。**没写收尾 `---` 时同样退化** —— 见 frontmatter.ts 的说明。
   */
  frontmatter?: boolean
}

/**
 * 围栏语言名 → 语言描述。**高亮和语言选择器共用这一个函数。**
 *
 * 在上游的 `matchLanguageName` 之上补了一条**扩展名兜底**：
 * `py`、`rb`、`kt` 这些是扩展名而不是别名，上游（即便开了 fuzzy）匹配不到，
 * 于是 ```` ```py ```` 一直是不高亮的 —— 而这恰恰是最常见的写法之一。
 *
 * 匹配不上返回 null，围栏内容按纯文本呈现，不报错、不吞内容（原则 P2）。
 */
function matchCodeLanguage(
  info: string,
  list: readonly LanguageDescription[],
): LanguageDescription | null {
  // 围栏信息串里空格之后的部分是附加属性（`js {highlight=1-3}`），不参与匹配
  const name = /\S*/.exec(info.trim())?.[0] ?? ''
  if (!name) return null

  const byName = LanguageDescription.matchLanguageName([...list], name, true)
  if (byName) return byName

  const lower = name.toLowerCase()
  return list.find((lang) => lang.extensions.some((ext) => ext.toLowerCase() === lower)) ?? null
}

export function markdownLanguageSupport(
  options: MarkdownLanguageOptions = {},
): LanguageSupport {
  const {
    dialect = 'gfm',
    extensions = [],
    codeLanguages = languages,
    frontmatter = true,
  } = options

  return markdown({
    base: commonmarkLanguage,
    extensions: [
      ...(dialect === 'gfm' ? GFM_EXTENSIONS : []),
      ...(frontmatter ? [frontmatterExtension] : []),
      ...extensions,
    ],
    // Lezer 的混合语言解析：``` 后面写的语言名会被交给对应的解析器，
    // 产出的 token 直接落进现有的 HighlightStyle，不需要第二套渲染路径。
    //
    // 传函数而不是数组，为的是让匹配规则只有一份 —— 传数组的话上游会用它自己的
    // `matchLanguageName`，跟语言选择器那边分家（见 resolveCodeLanguage 的说明）。
    // 返回 LanguageDescription 时上游照旧走懒加载，体积不受影响。
    codeLanguages: (info) => matchCodeLanguage(info, codeLanguages),
    addKeymap: false, // 键位由 @typo/editor 统一管理，避免两处定义打架
  })
}

/**
 * 可选的代码语言名清单（首选名，已排序）。
 *
 * 给编辑器的语言选择器用。放在这里而不是让 @typo/editor 自己去 import
 * `@codemirror/language-data`：语言表是「解析器认识哪些语言」这件事的一部分，
 * 两处各自维护一份迟早会对不上（选择器里有、解析器不认，或者反过来）。
 */
export function codeLanguageNames(options: MarkdownLanguageOptions = {}): string[] {
  const { codeLanguages = languages } = options
  return [...codeLanguages].map((lang) => lang.name).sort((a, b) => a.localeCompare(b))
}

/**
 * 把用户写的语言名（`js`、`JS`、`node`、`py`）归一成 `codeLanguageNames()`
 * 里的首选名。给代码块的语言选择器用。
 *
 * 走的是**和高亮完全同一个** `matchCodeLanguage`。这不是洁癖：两套规则一旦
 * 分家，界面上就会出现「下拉框显示纯文本、代码却是彩色的」这种自相矛盾的状态，
 * 而且用户一旦碰那个下拉框，就会把本来好好的语言标注改掉。
 *
 * 匹配不上返回 null —— 调用方据此按「未知语言」处理，不猜、不报错（原则 P2）。
 */
export function resolveCodeLanguage(
  info: string,
  options: MarkdownLanguageOptions = {},
): string | null {
  const { codeLanguages = languages } = options
  return matchCodeLanguage(info, codeLanguages)?.name ?? null
}
