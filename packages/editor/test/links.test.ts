import { describe, expect, it } from 'vitest'
import { linkTargetAt } from '@typo/editor'
import { mkState } from './helpers.js'

/** 取文档中某个子串中间位置的链接目标。 */
function targetAt(doc: string, inside: string): string | null {
  const index = doc.indexOf(inside)
  const state = mkState(doc)
  return linkTargetAt(state, index + Math.floor(inside.length / 2))
}

describe('linkTargetAt', () => {
  it('行内链接：从语法树里取 URL，而不是读渲染后的文字', () => {
    // 这正是不能靠 DOM 文本的原因 —— 渲染出来只有「文档」两个字，URL 是藏着的
    expect(targetAt('见 [文档](https://example.com) 了解', '文档')).toBe('https://example.com')
  })

  it('自动链接', () => {
    expect(targetAt('见 <https://example.com> 了解', 'example')).toBe('https://example.com')
  })

  it('相对路径链接原样返回，由宿主决定怎么处理', () => {
    expect(targetAt('见 [说明](./docs/readme.md)', '说明')).toBe('./docs/readme.md')
  })

  it('引用式链接拿不到目标（需要语义层解析定义，M3 的事）', () => {
    expect(targetAt('见 [文档][ref] 了解', '文档')).toBe(null)
  })

  it('不在链接上时返回 null', () => {
    expect(targetAt('普通段落文字', '段落')).toBe(null)
  })

  it('链接文字里的强调不影响取值', () => {
    expect(targetAt('[**重点**文档](https://example.com)', '重点')).toBe('https://example.com')
  })

  it('裸的方括号不算链接', () => {
    expect(targetAt('[TODO] 待办事项', 'TODO')).toBe(null)
  })

  it('URL 两端的空白被裁掉', () => {
    expect(targetAt('[文档](  https://example.com  )', '文档')).toBe('https://example.com')
  })
})
