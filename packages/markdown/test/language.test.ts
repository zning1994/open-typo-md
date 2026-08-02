/**
 * 语言清单与别名归一。
 *
 * 这两个函数服务于代码块的语言选择器 —— 它们对不上的表现很隐蔽：
 * 下拉框里选了个语言，文档里写进去了，高亮却不生效。
 */
import { describe, expect, it } from 'vitest'
import { codeLanguageNames, resolveCodeLanguage } from '../src/index.js'

describe('codeLanguageNames', () => {
  it('给出一份非空且已排序的清单', () => {
    const names = codeLanguageNames()
    expect(names.length).toBeGreaterThan(50)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
  })

  it('常用语言都在里面', () => {
    const names = codeLanguageNames()
    for (const lang of ['JavaScript', 'TypeScript', 'Python', 'Rust', 'JSON', 'YAML']) {
      expect(names).toContain(lang)
    }
  })

  it('传空清单就是空的（体积敏感的宿主可以整个关掉）', () => {
    expect(codeLanguageNames({ codeLanguages: [] })).toEqual([])
  })
})

describe('resolveCodeLanguage', () => {
  it.each([
    ['js', 'JavaScript'],
    ['JS', 'JavaScript'],
    ['javascript', 'JavaScript'],
    ['ts', 'TypeScript'],
    ['py', 'Python'], // 只在扩展名表里、不在别名表里 —— 但高亮认它，选择器也得认
    ['yml', 'YAML'],
    ['sh', 'Shell'],
  ])('%s → %s', (written, expected) => {
    expect(resolveCodeLanguage(written)).toBe(expected)
  })

  it('围栏信息串里空格之后的属性不参与匹配', () => {
    expect(resolveCodeLanguage('js {highlight=1-3}')).toBe('JavaScript')
  })

  it('前后空白不影响', () => {
    expect(resolveCodeLanguage('  python  ')).toBe('Python')
  })

  it('认不出来返回 null —— 不猜、不报错', () => {
    expect(resolveCodeLanguage('这不是语言')).toBe(null)
    expect(resolveCodeLanguage('')).toBe(null)
    expect(resolveCodeLanguage('   ')).toBe(null)
  })
})

describe('扩展名兜底', () => {
  /**
   * 上游的 matchLanguageName 只认「名字 + 别名」。而 `py`、`rb`、`kt` 这些
   * 是扩展名 —— 恰恰又是最常见的写法。补这条兜底之前，```py 是不高亮的。
   */
  it.each([
    ['py', 'Python'],
    ['rb', 'Ruby'],
    ['kt', 'Kotlin'],
    ['yml', 'YAML'],
  ])('%s → %s', (written, expected) => {
    expect(resolveCodeLanguage(written)).toBe(expected)
  })

  it('大小写不敏感', () => {
    expect(resolveCodeLanguage('PY')).toBe('Python')
  })
})

/**
 * 「不要高亮」的写法（issue #3）。
 *
 * 这几个词必须在**扩展名兜底之前**短路掉，否则会撞上别人的扩展名声明。
 * 实际撞上的是 sTeX：它声明了 `extensions: ['text', 'tex', …]`，
 * 于是 ```` ```text ```` 的语言选择器显示「sTeX」，
 * 而 `\section{}` 被按 TeX 命令着了色。
 */
describe('纯文本围栏', () => {
  it.each(['text', 'plain', 'plaintext', 'txt'])('%s → 不匹配任何语言', (written) => {
    expect(resolveCodeLanguage(written)).toBeNull()
  })

  it('大小写不敏感', () => {
    expect(resolveCodeLanguage('TEXT')).toBeNull()
    expect(resolveCodeLanguage('PlainText')).toBeNull()
  })

  it('不写语言时本来就是 null —— 两条路给出同一个答案', () => {
    expect(resolveCodeLanguage('')).toBeNull()
  })

  it('真正的 TeX / LaTeX 照常认得出来 —— 挡掉的只是 `text` 这个词', () => {
    expect(resolveCodeLanguage('tex')).not.toBeNull()
    expect(resolveCodeLanguage('latex')).not.toBeNull()
  })

  it('带附加属性时也短路', () => {
    expect(resolveCodeLanguage('text {highlight=1}')).toBeNull()
  })
})
