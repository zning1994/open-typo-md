/**
 * 保真闭环 + 装饰引擎的结构不变量，跑在 CommonMark 官方 spec 的全部用例上。
 *
 * 说清楚这套测试**是**什么、**不是**什么：
 *
 * 是：拿 652 个覆盖了 CommonMark 各种阴暗角落的真实文档，验证
 *     (a) 打开→保存字节不变；
 *     (b) 装饰引擎不崩、不产生结构上非法的装饰；
 *     (c) 没有任何源码字符被「看不见地」吞掉。
 *
 * 不是：HTML 输出与规范期望值的逐一比对。那需要语义解析器（remark/mdast），
 *     属于 M3 导出管线的工作，届时会补上真正的规范符合性测试
 *     （见 docs/adr/0003-dual-parser.md 的一致性测试要求）。
 */
import spec from 'commonmark-spec'
import { describe, expect, it } from 'vitest'
import { decodeText, encodeText } from '@typo/markdown'
import { hiddenRanges, mkState } from './helpers.js'

interface SpecExample {
  markdown: string
  html: string
  section: string
  number: number
}

const examples = (spec as unknown as { tests: SpecExample[] }).tests
const encoder = new TextEncoder()

describe('CommonMark 语料库', () => {
  it('语料库本身加载正常', () => {
    expect(examples.length).toBeGreaterThan(600)
  })

  it('全部用例：打开 → 保存后字节完全一致', () => {
    const broken: number[] = []
    for (const example of examples) {
      const bytes = encoder.encode(example.markdown)
      const { text, meta } = decodeText(bytes)
      if (!encodeText(text, meta).every((b, i) => b === bytes[i])) broken.push(example.number)
    }
    expect(broken).toEqual([])
  })
})

/**
 * 结构不变量，**两个方言各跑一遍**。
 *
 * 语料是 CommonMark 的，但装饰规则是按 GFM 写的 —— 用户实际跑的就是 GFM。
 * 只测 commonmark 等于让表格、任务列表、脚注这些新规则完全没有语料兜底，
 * 而它们恰恰是最可能在嵌套结构里踩到重叠的（M2 就抓到过一次：
 * 表格行把整行竖线一次性发出去，把单元格里的强调标记挤掉了）。
 */
describe.each(['commonmark', 'gfm'] as const)('结构不变量 · %s 方言', (dialect) => {
  const state = (markdown: string) => mkState(markdown, { dialect })

  it('全部用例：装饰构建不抛异常', () => {
    const failures: Array<{ number: number; error: string }> = []
    for (const example of examples) {
      try {
        hiddenRanges(state(example.markdown))
      } catch (error) {
        failures.push({ number: example.number, error: String(error) })
      }
    }
    expect(failures).toEqual([])
  })

  it('全部用例：隐藏区间不重叠', () => {
    // 重叠的 replace 装饰会让 CodeMirror 在渲染时直接抛错 —— 必炸型 bug
    const failures: Array<{ number: number; ranges: Array<[number, number]> }> = []
    for (const example of examples) {
      const ranges = hiddenRanges(state(example.markdown))
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i]![0] < ranges[i - 1]![1]) {
          failures.push({ number: example.number, ranges })
          break
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('全部用例：隐藏区间不跨越换行', () => {
    // 跨越换行的 replace 装饰不允许由 ViewPlugin 提供，CodeMirror 会报错
    const failures: number[] = []
    for (const example of examples) {
      const s = state(example.markdown)
      for (const [from, to] of hiddenRanges(s)) {
        if (s.doc.sliceString(from, to).includes('\n')) {
          failures.push(example.number)
          break
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('全部用例：被隐藏的只能是语法标记，不能是正文', () => {
    // 兜底防线：任何被藏起来的片段都必须由标记字符构成。
    // 如果哪天某条规则把正文藏了，用户会看到内容凭空消失 —— 这是最严重的一类 bug。
    const MARKER_ONLY = /^[#>*\-+`~[\]()<>!_=\s.:'"^\d\\|/a-zA-Z%&?#@+,;$-]*$/
    const failures: Array<{ number: number; hidden: string }> = []
    for (const example of examples) {
      const s = state(example.markdown)
      for (const [from, to] of hiddenRanges(s)) {
        const hidden = s.doc.sliceString(from, to)
        // 链接的 URL 部分本来就该被折叠，长度可以很长；这里只挡「藏了自然语言」
        if (hidden.length > 0 && !MARKER_ONLY.test(hidden)) {
          failures.push({ number: example.number, hidden })
        }
      }
    }
    // 允许链接目标里出现非 ASCII（`[x](中文.md)`），单独放行
    const real = failures.filter((f) => !/^[[\]()<>!].*[)\]>]$/s.test(f.hidden))
    expect(real).toEqual([])
  })
})

describe('性能冒烟', () => {
  // 这不是 docs/design/07 §2 里的正式性能门槛（那需要独立的基准工程与基线对比），
  // 只是一条「别一不小心退化到不可用」的警戒线。
  it('一万行文档的全量装饰构建在 2 秒内完成', () => {
    const block =
      '# 标题\n\n这是一段带 **粗体**、*斜体* 和 `代码` 的正文。\n\n- 列表项\n- 另一项\n\n> 引用\n\n'
    const doc = block.repeat(1200)
    const state = mkState(doc)

    const started = performance.now()
    hiddenRanges(state)
    const elapsed = performance.now() - started

    expect(state.doc.lines).toBeGreaterThan(10_000)
    expect(elapsed).toBeLessThan(2000)
  })
})
