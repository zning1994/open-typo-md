/**
 * 「复制为富文本」→ 粘回 Mosu（issue #14 的回归）。
 *
 * ## 为什么这条用例住在这里
 *
 * 它要同时用 `@mosu/export` 和 `@mosu/import`，而这两个包**互相不认识**
 * （分层规则：export 只能依赖 markdown / plugin-api，import 谁都不依赖）。
 * `apps/desktop` 是唯一同时看得见两边的地方 —— 也正是产品里这条链路真正
 * 发生的地方（复制走 `renderer/export.ts`，粘贴走 `editor/paste.ts`）。
 *
 * ## 这条缝为什么会漏
 *
 * 两个包各自的用例都是绿的，绿的是**各自的规则**：导出那边验「公式只剩一份
 * 表示」，粘贴那边验「Word / Google 文档的各种坏 HTML 别转坏」。
 * 没有任何一条用例问过「导出的东西粘回来还是不是原来那篇文档」。
 *
 * 结果是修 #14 时我把 `<annotation>`（那份原始 TeX）删掉了 —— 对导出是对的，
 * 它在不支持 MathML 的目标里会露成第二份可见文本；但那串 TeX 是这段公式
 * **唯一无损的表示**，`<math>` 的元素树只够渲染、反推不回源码。于是用户从
 * Mosu 复制为富文本再粘回 Mosu，粗体在、公式一个字都不剩。
 *
 * 现在 TeX 搬到了 `data-tex` 属性上：属性在任何目标里都不会被当成文本渲染
 * 出来，所以「只剩一份」和「往返无损」可以同时成立。
 */
import { describe, expect, it } from 'vitest'
import { markdownToHtmlFragment } from '@mosu/export'
import { htmlToMarkdown } from '@mosu/import'

/** 走一遍「复制为富文本 → 粘贴」。 */
async function roundTrip(markdown: string): Promise<string | null> {
  return htmlToMarkdown(await markdownToHtmlFragment(markdown, { forFragment: true }))
}

describe('复制为富文本再粘回来', () => {
  it('用户报的那条：粗体和公式都得回来', async () => {
    // issue #14 的复现步骤，一字不改：全选 `**粗体**` + `$x^2$`，
    // 复制为富文本，粘回 Mosu。修之前公式整个没了
    expect(await roundTrip('**粗体**\n\n$x^2$')).toBe('**粗体**\n\n$x^2$')
  })

  it('行内公式与块级公式分得清 —— $ 不能变成 $$，反过来也不行', async () => {
    const out = await roundTrip('行内 $x^2$ 完\n\n$$\n\\int_0^1 x\n$$')
    expect(out).toContain('行内 $x^2$ 完')
    expect(out).toContain('$$\n\\int_0^1 x\n$$')
  })

  it('复杂一点的 TeX 一个字符都不差', async () => {
    const tex = '$\\frac{a}{b} + \\sqrt{c}$'
    expect(await roundTrip(tex)).toBe(tex)
  })

  it('整篇只有一个公式时也走转换 —— 纯文本表示不了它', async () => {
    // 归一之后的 `<math>` 没有子节点，一度被「空段落就丢掉」那条规则整段删掉
    expect(await roundTrip('$x^2$')).toBe('$x^2$')
  })

  it('TeX 里的引号能活着回来 —— 它要穿过一次 HTML 属性', async () => {
    const tex = '$\\text{"q"}$'
    expect(await roundTrip(tex)).toBe(tex)
  })

  it('公式之外的结构照旧', async () => {
    const out = await roundTrip('# 标题\n\n- 甲\n- 乙\n\n> 引用\n\n`代码`')
    expect(out).toContain('# 标题')
    expect(out).toContain('- 甲')
    expect(out).toContain('> 引用')
    expect(out).toContain('`代码`')
  })

  it('片段里那些内联的 style 属性不会漏进 Markdown', async () => {
    // 导出片段会给 blockquote / code 摊上行内样式（#14 的另一半）。
    // 粘回来时它们只是渲染细节，不该变成正文里的任何东西
    const out = (await roundTrip('> 引用\n\n`代码`')) ?? ''
    expect(out).not.toContain('style')
    expect(out).not.toContain('border-left')
  })
})
