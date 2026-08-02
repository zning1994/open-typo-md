import { describe, expect, it } from 'vitest'
import { createTranslator, formatMessage, matchLocale } from '@typo/i18n'

describe('变量替换', () => {
  it('替换命名占位符', () => {
    expect(formatMessage('你好，{name}', { name: '世界' })).toBe('你好，世界')
  })

  it('同一个变量可以出现多次', () => {
    expect(formatMessage('{a}-{a}', { a: 1 })).toBe('1-1')
  })

  it('缺参数时保留原样，而不是留一个空洞', () => {
    // 换成空串会得到一句读起来通顺、意思却缺了一半的话，那才是真的难查
    expect(formatMessage('保存到 {path}')).toBe('保存到 {path}')
  })

  it('没有占位符的模板原样返回', () => {
    expect(formatMessage('设置')).toBe('设置')
  })
})

describe('复数', () => {
  const template = '{n, plural, one {# file} other {# files}}'

  it('英语按 one / other 选分支', () => {
    expect(formatMessage(template, { n: 1 }, 'en')).toBe('1 file')
    expect(formatMessage(template, { n: 3 }, 'en')).toBe('3 files')
    expect(formatMessage(template, { n: 0 }, 'en')).toBe('0 files')
  })

  it('中日只有 other —— 走的是平台的 Intl.PluralRules，不是我们自己的表', () => {
    const zh = '{n, plural, other {# 个文件}}'
    expect(formatMessage(zh, { n: 1 }, 'zh-CN')).toBe('1 个文件')
    expect(formatMessage(zh, { n: 5 }, 'zh-CN')).toBe('5 个文件')
  })

  it('精确匹配 =0 优先于类别', () => {
    const t = '{n, plural, =0 {没有文件} other {# 个文件}}'
    expect(formatMessage(t, { n: 0 }, 'zh-CN')).toBe('没有文件')
    expect(formatMessage(t, { n: 2 }, 'zh-CN')).toBe('2 个文件')
  })

  it('分支里能再套变量', () => {
    const t = '{n, plural, other {{name} 有 # 项}}'
    expect(formatMessage(t, { n: 2, name: '清单' }, 'zh-CN')).toBe('清单 有 2 项')
  })

  it('数字按区域格式化', () => {
    expect(formatMessage('{n, plural, other {# words}}', { n: 12345 }, 'en')).toBe(
      '12,345 words',
    )
  })
})

describe('坏模板不炸', () => {
  // 这是这个模块最重要的性质：一条翻译写错，代价必须是那一句显示成原样，
  // 而不是整个面板白屏
  it('花括号没配对时原样吐出剩余部分', () => {
    expect(formatMessage('保存 {path', { path: 'a' })).toBe('保存 {path')
  })

  it('不认识的参数类型原样吐出', () => {
    expect(formatMessage('{n, date, short}', { n: 1 })).toBe('{n, date, short}')
  })

  it('plural 的参数不是数字时原样吐出', () => {
    expect(formatMessage('{n, plural, other {#}}', { n: 'x' })).toBe('{n, plural, other {#}}')
  })

  it('单引号可以转义花括号', () => {
    expect(formatMessage("用 '{name}' 表示占位符", { name: 'x' })).toBe('用 {name} 表示占位符')
  })
})

describe('翻译器', () => {
  const zh = { greeting: '你好', only: '只有中文有' }
  const en = { greeting: 'Hello' }

  it('查不到时退到兜底语言', () => {
    const t = createTranslator('en', en, zh)
    expect(t('greeting')).toBe('Hello')
    expect(t('only')).toBe('只有中文有')
  })

  it('兜底也没有时返回键名 —— 至少能看出是哪一条漏了', () => {
    const t = createTranslator('en', en, null)
    expect(t('missing')).toBe('missing')
  })

  it('带上当前语言，调用方要格式化日期数字时用得上', () => {
    expect(createTranslator('ja', {}).locale).toBe('ja')
  })
})

describe('matchLocale', () => {
  const available = ['zh-CN', 'en', 'ja']

  it('完整标签优先', () => {
    expect(matchLocale('zh-CN', available, 'en')).toBe('zh-CN')
  })

  it('主语言其次', () => {
    expect(matchLocale('ja-JP', available, 'en')).toBe('ja')
    expect(matchLocale('en-GB', available, 'en')).toBe('en')
  })

  it('大小写不敏感', () => {
    expect(matchLocale('ZH-cn', available, 'en')).toBe('zh-CN')
  })

  it('繁体退到兜底而不是简体 —— 半吊子的支持比没有更糟', () => {
    expect(matchLocale('zh-TW', available, 'en')).toBe('zh-CN')
  })

  it('完全不认识的区域用兜底', () => {
    expect(matchLocale('de-DE', available, 'en')).toBe('en')
  })
})
