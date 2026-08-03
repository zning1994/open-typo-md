/**
 * 文档标题的提取（issue #36）。
 *
 * 这一组的重点全在**不该认的那些**：一个天真的 `/^#+ /` 正则能过掉下面
 * 一半的用例，而它在真实仓库里会把 shell 脚本的注释、front matter 的界栏、
 * `#hashtag` 全当成标题挂到文件树上。
 */
import { describe, expect, it } from 'vitest'
import { firstHeading } from '../src/title.js'

describe('firstHeading', () => {
  it('认最普通的 ATX 标题', () => {
    expect(firstHeading('# 我的文档\n\n正文')).toEqual({ text: '我的文档', level: 1 })
  })

  it('第一个标题不是 H1 时也认 —— 文件树要的是「最靠前那个」', () => {
    expect(firstHeading('## 小节\n\n正文')).toEqual({ text: '小节', level: 2 })
  })

  it('吃掉收尾的那串 #', () => {
    expect(firstHeading('### 标题 ###')).toEqual({ text: '标题', level: 3 })
  })

  it('最多三个前导空格仍是标题，第四个就是缩进代码块了', () => {
    expect(firstHeading('   # 有缩进')).toEqual({ text: '有缩进', level: 1 })
    expect(firstHeading('    # 四个空格是代码')).toBeNull()
  })

  it('`#hashtag` 不是标题 —— # 后面必须有空白', () => {
    expect(firstHeading('#hashtag 不是标题\n\n正文')).toBeNull()
  })

  it('空标题回退到 null，而不是给出空字符串', () => {
    // 拿空串当文件树的标签等于把那一行变成空白，还不如显示文件名
    expect(firstHeading('##\n\n正文')).toBeNull()
  })

  describe('YAML front matter', () => {
    it('整块跳过，认后面的标题', () => {
      const doc = '---\ntitle: 元数据里的标题\ntags: [a]\n---\n\n# 正文标题\n'
      expect(firstHeading(doc)).toEqual({ text: '正文标题', level: 1 })
    })

    it('收尾的 --- 不会被当成 Setext 下划线', () => {
      // 这是最容易写错的一处：`tags: [a]` + `---` 在 Setext 规则眼里
      // 就是一个二级标题，于是文件树上会出现一行 `tags: [a]`
      const doc = '---\ntitle: x\ntags: [a]\n---\n\n# 正文标题\n'
      expect(firstHeading(doc)?.text).toBe('正文标题')
    })

    it('没有收尾栏时不跳 —— 跳掉等于把整篇文档吞了', () => {
      // 用户敲下 `---` 之后、写完元数据之前的每一秒都是这个状态
      expect(firstHeading('---\n# 这其实是标题\n')).toEqual({
        text: '这其实是标题',
        level: 1,
      })
    })
  })

  describe('代码块', () => {
    it('围栏里的 # 不是标题', () => {
      const doc = '```sh\n# 这是 shell 注释\necho hi\n```\n\n# 真标题\n'
      expect(firstHeading(doc)).toEqual({ text: '真标题', level: 1 })
    })

    it('~~~ 围栏同样算数', () => {
      expect(firstHeading('~~~\n# 注释\n~~~\n\n# 真标题\n')?.text).toBe('真标题')
    })

    it('闭栏必须同类且不短于开栏', () => {
      // ```` 开的块不会被 ``` 关掉，里面的 # 仍然不是标题
      const doc = '````\n```\n# 还在块里\n````\n\n# 真标题\n'
      expect(firstHeading(doc)?.text).toBe('真标题')
    })

    it('围栏没闭合时整篇都在块里，返回 null', () => {
      expect(firstHeading('```\n# 注释\n没有闭合')).toBeNull()
    })
  })

  describe('Setext 标题', () => {
    it('=== 是一级', () => {
      expect(firstHeading('文档标题\n===\n\n正文')).toEqual({ text: '文档标题', level: 1 })
    })

    it('--- 是二级', () => {
      expect(firstHeading('文档标题\n---\n\n正文')).toEqual({ text: '文档标题', level: 2 })
    })

    it('前一行是空行时那是分隔线，不是标题', () => {
      expect(firstHeading('\n---\n\n正文')).toBeNull()
    })

    it('ATX 在前就用 ATX', () => {
      expect(firstHeading('# 一级\n\n二级\n---\n')).toEqual({ text: '一级', level: 1 })
    })
  })

  it('通篇没有标题就返回 null，由调用方回退到文件名', () => {
    expect(firstHeading('只有正文。\n\n还是正文。')).toBeNull()
  })

  it('CRLF 换行照样认', () => {
    expect(firstHeading('# 标题\r\n\r\n正文')).toEqual({ text: '标题', level: 1 })
  })

  it('标题在 maxLines 之外时返回 null', () => {
    // 与其扫完一个几十 MB 的文件，不如用文件名标识它 —— 那更诚实
    const doc = `${'正文\n'.repeat(50)}# 太靠后的标题\n`
    expect(firstHeading(doc, 10)).toBeNull()
    expect(firstHeading(doc, 100)?.text).toBe('太靠后的标题')
  })
})
