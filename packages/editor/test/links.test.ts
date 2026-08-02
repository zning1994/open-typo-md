import { describe, expect, it } from 'vitest'
import { linkTargetAt } from '@mosu/editor'
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

describe('GFM 自动链接', () => {
  it('带协议的原样返回', () => {
    expect(targetAt('访问 https://example.com/a 看看', 'example')).toBe('https://example.com/a')
  })

  it('省略协议的裸域名补上 https://', () => {
    // GFM 允许 `www.x.com` 这种写法，但直接交给系统浏览器打不开
    expect(targetAt('访问 www.example.com 看看', 'example')).toBe('https://www.example.com')
  })

  it('邮箱补上 mailto:', () => {
    expect(targetAt('联系 someone@example.com 吧', 'example')).toBe(
      'mailto:someone@example.com',
    )
  })

  it('非 http 协议照传，挡不挡由 main 侧的白名单说了算', () => {
    expect(targetAt('见 <ftp://example.com/x> 吧', 'example')).toBe('ftp://example.com/x')
  })

  it('行内链接的 URL 不会被自动链接规则抢走', () => {
    expect(targetAt('[文档](./local.md)', '文档')).toBe('./local.md')
  })

  it('光标落在行内链接的 URL 上时，取的仍是那个 URL 本身', () => {
    // 折叠状态下用户点不到这里，但显形时能点 —— 不能因此补出个 https:// 前缀
    expect(targetAt('[文档](./local.md)', 'local')).toBe('./local.md')
  })

  it('严格 CommonMark 下没有自动链接，裸 URL 不可点', () => {
    const doc = '访问 www.example.com 看看'
    const state = mkState(doc, { dialect: 'commonmark' })
    expect(linkTargetAt(state, doc.indexOf('example'))).toBe(null)
  })
})
