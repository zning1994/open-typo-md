/**
 * 工作区遍历与搜索（issues #37 / #39）。
 *
 * 跑在真实临时目录上。这一组盯的是两类会悄悄骗人的东西：
 *
 * 1. **遍历的边界** —— 上限撞到了却不说、点目录漏进来、符号链接转不出去；
 * 2. **查询的编译** —— 非正则模式忘了转义（用户搜 `a.md` 会命中 `axmd`）、
 *    零宽匹配把 exec 卡死、`g` 标志的 lastIndex 跨行残留。
 *
 * 第 2 类尤其值得单测：它们都不会报错，只会给出「看不出为什么」的结果。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compileQuery,
  findInText,
  searchWorkspace,
  walkWorkspace,
  type SearchOptions,
  type SearchProgress,
} from '../src/main/workspace-scan.js'
import { grantDirectory, resetGrantsForTest } from '../src/main/path-guard.js'

let root: string

beforeEach(async () => {
  resetGrantsForTest()
  root = await mkdtemp(path.join(tmpdir(), 'mosu-scan-'))
  await grantDirectory(root)
})

afterEach(async () => {
  resetGrantsForTest()
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
})

const at = (...parts: string[]) => path.join(root, ...parts)
const DEFAULTS: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false }

describe('遍历工作区', () => {
  it('收得到嵌套目录里的 Markdown，路径是相对根的正斜杠形式', async () => {
    await mkdir(at('a', 'b'), { recursive: true })
    await writeFile(at('顶层.md'), 'x', 'utf8')
    await writeFile(at('a', 'b', '深处.md'), 'x', 'utf8')

    const { files } = await walkWorkspace(root)
    expect(files.map((f) => f.relative).sort()).toEqual(['a/b/深处.md', '顶层.md'])
  })

  it('只收 Markdown —— 图片和二进制会把结果列表淹掉', async () => {
    await writeFile(at('文档.md'), 'x', 'utf8')
    await writeFile(at('图.png'), 'x', 'utf8')
    await writeFile(at('数据.json'), 'x', 'utf8')

    const { files } = await walkWorkspace(root)
    expect(files.map((f) => f.name)).toEqual(['文档.md'])
  })

  it('点目录与 node_modules 不进遍历', async () => {
    await mkdir(at('node_modules'))
    await mkdir(at('.git'))
    await writeFile(at('node_modules', '包.md'), 'x', 'utf8')
    await writeFile(at('.git', '记录.md'), 'x', 'utf8')
    await writeFile(at('正文.md'), 'x', 'utf8')

    const { files } = await walkWorkspace(root)
    expect(files.map((f) => f.name)).toEqual(['正文.md'])
  })

  it('不跟随符号链接目录 —— 跟随的话一个指回上级的链接就能转到天荒地老', async () => {
    await mkdir(at('真目录'))
    await writeFile(at('真目录', '里面.md'), 'x', 'utf8')
    await symlink(root, at('真目录', '回环'), 'dir')

    const { files, truncated } = await walkWorkspace(root)
    // 转出去的话这里要么爆栈要么撞深度上限
    expect(files.map((f) => f.relative)).toEqual(['真目录/里面.md'])
    expect(truncated).toBe(false)
  })

  it('工作区外的目录遍历不了', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'mosu-outside-'))
    try {
      await writeFile(path.join(outside, 'x.md'), 'x', 'utf8')
      await expect(walkWorkspace(outside)).rejects.toThrow()
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})

describe('查询的编译', () => {
  it('非正则模式下把元字符当字面量', () => {
    // 忘了转义的话 `a.md` 会命中 `axmd`，而用户看不出为什么
    const pattern = compileQuery('a.md', DEFAULTS)!
    expect(findInText('axmd', pattern)).toHaveLength(0)
    expect(findInText('a.md', compileQuery('a.md', DEFAULTS)!)).toHaveLength(1)
  })

  it('正则模式下元字符是元字符', () => {
    const pattern = compileQuery('a.md', { ...DEFAULTS, regex: true })!
    expect(findInText('axmd', pattern)).toHaveLength(1)
  })

  it('默认不分大小写，打开开关之后分', () => {
    expect(findInText('Hello', compileQuery('hello', DEFAULTS)!)).toHaveLength(1)
    expect(
      findInText('Hello', compileQuery('hello', { ...DEFAULTS, caseSensitive: true })!),
    ).toHaveLength(0)
  })

  it('整词只匹配完整的词', () => {
    const pattern = compileQuery('cat', { ...DEFAULTS, wholeWord: true })!
    expect(findInText('a cat here', pattern)).toHaveLength(1)
    expect(
      findInText('concatenate', compileQuery('cat', { ...DEFAULTS, wholeWord: true })!),
    ).toHaveLength(0)
  })

  it('写坏的正则返回 null，不抛 —— 边敲边搜时每个中间状态都是非法的', () => {
    expect(compileQuery('(未闭合', { ...DEFAULTS, regex: true })).toBeNull()
  })

  it('空查询返回 null', () => {
    expect(compileQuery('', DEFAULTS)).toBeNull()
  })
})

describe('在文本里找命中', () => {
  it('给出行号、列范围和整行文本', () => {
    const text = '第一行\n这里有目标在中间\n第三行'
    const [hit] = findInText(text, compileQuery('目标', DEFAULTS)!)
    expect(hit).toMatchObject({ line: 2, from: 3, to: 5, text: '这里有目标在中间' })
  })

  it('偏移量能直接用来定位 —— 拿它去 slice 得到的就是命中的那几个字', () => {
    const text = '第一行\n这里有目标在中间\n第三行'
    const [hit] = findInText(text, compileQuery('目标', DEFAULTS)!)
    expect(text.slice(hit!.offset, hit!.offset + 2)).toBe('目标')
  })

  it('一行里的多处命中都要给出来', () => {
    expect(findInText('猫 猫 猫', compileQuery('猫', DEFAULTS)!)).toHaveLength(3)
  })

  it('后面的行不会漏掉行首的命中', () => {
    // `g` 标志的 lastIndex 跨行残留时，第二行的行首命中会被跳过。
    // 表现是「有的命中报了有的没报」，看不出规律
    const hits = findInText('目标在这里\n目标在行首', compileQuery('目标', DEFAULTS)!)
    expect(hits.map((h) => h.line)).toEqual([1, 2])
    expect(hits[1]!.from).toBe(0)
  })

  it('零宽匹配不会把循环卡住', () => {
    // `x*` 在任何位置都能匹配空串，exec 会原地打转 —— 少了手动推进就是死循环
    const hits = findInText('abc', compileQuery('x*', { ...DEFAULTS, regex: true })!)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThan(20)
  })

  it('CRLF 文本的行号不会错位', () => {
    const hits = findInText('第一行\r\n目标\r\n', compileQuery('目标', DEFAULTS)!)
    expect(hits[0]?.line).toBe(2)
  })
})

describe('全工作区搜索', () => {
  const collect = async (query: string, options: Partial<SearchOptions> = {}) => {
    const seen: SearchProgress[] = []
    await searchWorkspace(
      root,
      query,
      { ...DEFAULTS, ...options },
      (progress) => seen.push(progress),
      () => false,
    )
    return seen
  }

  it('跨文件命中，结果带相对路径', async () => {
    await mkdir(at('子'))
    await writeFile(at('甲.md'), '这里有关键词。\n', 'utf8')
    await writeFile(at('子', '乙.md'), '另一处关键词。\n', 'utf8')
    await writeFile(at('丙.md'), '无关内容。\n', 'utf8')

    const progress = await collect('关键词')
    const matched = progress.flatMap((p) => p.matches)
    // 比集合而不是有序数组：批次顺序取决于遍历顺序，不是产品承诺
    expect(new Set(matched.map((m) => m.relative))).toEqual(new Set(['甲.md', '子/乙.md']))
  })

  it('最后一条永远是 done', async () => {
    await writeFile(at('甲.md'), '关键词\n', 'utf8')
    const progress = await collect('关键词')
    expect(progress[progress.length - 1]?.done).toBe(true)
    // 中间那些批次不该带 done —— 界面靠它决定什么时候收起「搜索中」
    expect(progress.slice(0, -1).every((p) => !p.done)).toBe(true)
  })

  it('没有命中时也要给一条 done，而不是什么都不发', async () => {
    // 不发的话界面会永远停在「搜索中」
    await writeFile(at('甲.md'), '无关内容\n', 'utf8')
    const progress = await collect('找不到的词')
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ done: true, matches: [] })
  })

  it('范围限定只搜那个子目录', async () => {
    await mkdir(at('子'))
    await writeFile(at('顶层.md'), '关键词\n', 'utf8')
    await writeFile(at('子', '里面.md'), '关键词\n', 'utf8')

    const progress = await collect('关键词', { scope: '子' })
    const matched = progress.flatMap((p) => p.matches)
    expect(matched.map((m) => m.relative)).toEqual(['子/里面.md'])
  })

  it('shouldStop 为真时立刻收手，一条都不再发', async () => {
    // 用户改了查询词就该把上一次丢掉 —— 不检查的话连敲五个字符会同时跑五次
    // 搜索，结果交错着涌进同一个列表
    await writeFile(at('甲.md'), '关键词\n', 'utf8')
    const seen: SearchProgress[] = []
    await searchWorkspace(
      root,
      '关键词',
      DEFAULTS,
      (p) => seen.push(p),
      () => true,
    )
    expect(seen).toEqual([])
  })

  it('空查询直接给一条 done', async () => {
    const progress = await collect('')
    expect(progress).toEqual([{ matches: [], done: true, truncated: false }])
  })
})
