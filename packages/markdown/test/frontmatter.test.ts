/**
 * YAML front matter 的解析形状。
 *
 * 重点在**没闭合时必须退化**：那是用户敲下 `---` 之后、写完元数据之前的
 * 每一秒，而上游的 `yamlFrontmatter` 在这种状态下会把全文都当成 YAML，
 * 整篇文章的渲染当场塌掉。自己写这个扩展的唯一理由就是它（见 frontmatter.ts）。
 */
import { describe, expect, it } from 'vitest'
import type { Tree } from '@lezer/common'
import { markdownLanguageSupport } from '../src/index.js'

function parse(doc: string, frontmatter = true): Tree {
  return markdownLanguageSupport({ codeLanguages: [], frontmatter }).language.parser.parse(doc)
}

function nodeNames(doc: string, frontmatter = true): string[] {
  const names: string[] = []
  parse(doc, frontmatter).iterate({ enter: (n) => void names.push(n.name) })
  return names
}

const WITH_FM = '---\ntitle: 标题\ntags: [a, b]\n---\n\n# 正文标题\n\n段落'

describe('YAML front matter', () => {
  it('文档开头的 --- 块被识别成 Frontmatter', () => {
    expect(nodeNames(WITH_FM)).toContain('Frontmatter')
  })

  it('里面的内容按 YAML 解析，不是纯文本', () => {
    // parseMixed 会把 FrontmatterContent 换成挂载进来的 YAML 子树，
    // 所以看到的是 YAML 自己的节点名，而不是那个占位节点
    const names = nodeNames(WITH_FM)
    expect(names).toContain('Pair')
    expect(names).toContain('Key')
    expect(names).toContain('FlowSequence') // tags: [a, b]
  })

  it('开闭两条 --- 都标成 FrontmatterMark', () => {
    const marks = nodeNames(WITH_FM).filter((n) => n === 'FrontmatterMark')
    expect(marks).toHaveLength(2)
  })

  it('正文照常按 Markdown 解析', () => {
    const names = nodeNames(WITH_FM)
    expect(names).toContain('ATXHeading1')
    expect(names).toContain('Paragraph')
  })

  it('正文里的 GFM 语法也照常生效 —— 外层包装不影响内层方言', () => {
    const doc = '---\na: 1\n---\n\n| x |\n| --- |\n| 1 |'
    expect(nodeNames(doc)).toContain('Table')
  })

  it('不在文档开头的 --- 仍然是分隔线，不是 front matter', () => {
    const doc = '段落\n\n---\n\n后面'
    const names = nodeNames(doc)
    expect(names).not.toContain('Frontmatter')
    expect(names).toContain('HorizontalRule')
  })

  it('关掉之后退化成普通 Markdown，内容一个字不少', () => {
    const names = nodeNames(WITH_FM, false)
    expect(names).not.toContain('Frontmatter')
    expect(names).toContain('ATXHeading1') // 正文仍然正常
  })

  it('没写收尾 --- 时，元数据块止步于空行，正文照常按 Markdown 渲染', () => {
    // 这是自己写这个扩展的唯一理由。上游的 yamlFrontmatter 在这里会把
    // **剩下的全文**都当成 YAML —— 而「没闭合」正是用户正在输入的那一秒，
    // 整篇文章的渲染当场塌掉。
    //
    // Lezer 不给任意前瞻（块解析器一旦 nextLine 就没有回退），所以做不到
    // 「没闭合就整块退化」；能做到的是以空行为界，把塌掉的范围收窄到
    // 用户正在写的那一段。真实文档里元数据与正文之间一定隔着空行。
    const doc = '---\ntitle: 只有开头\n\n# 后面的标题\n\n- 列表'
    const names = nodeNames(doc)

    expect(names).toContain('Frontmatter')
    // 关键在这里：正文一点没被卷进去
    expect(names).toContain('ATXHeading1')
    expect(names).toContain('BulletList')
  })

  it('空的 front matter 不会崩', () => {
    expect(() => nodeNames('---\n---\n\n正文')).not.toThrow()
    expect(nodeNames('---\n---\n\n正文')).toContain('Frontmatter')
  })

  it('只有一行 --- 后面直接空行 —— 那是分隔线，不是 front matter', () => {
    // 这个判断必须在消耗任何行**之前**做完（用 peekLine），
    // 因为 Lezer 的块解析器一旦 nextLine 就没有回退可言
    const names = nodeNames('---\n\n# 标题')
    expect(names).not.toContain('Frontmatter')
    expect(names).toContain('ATXHeading1')
  })

  it('围栏可以多于三个短横', () => {
    expect(nodeNames('-----\na: 1\n-----\n\n正文')).toContain('Frontmatter')
  })

  it('前面有空行就不是 front matter 了 —— 必须顶在文档最开头', () => {
    expect(nodeNames('\n---\na: 1\n---\n')).not.toContain('Frontmatter')
  })
})
