/**
 * 用户偏好的读写与校验。
 *
 * 值得单独测的只有**校验**这一件事：`settings.json` 就在用户数据目录里，
 * 明摆着让人直接改，所以读进来的每个值都可能是任何东西。
 * 一个坏值不该让编辑器打不开，也不该让 PDF 用一个荒唐的页边距。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { KeyValueStore } from '@typo/plugin-api'
import { DEFAULT_PREFERENCES, PreferenceStore } from '../src/renderer/preferences.js'

/** 内存版设置存储，可以直接塞进任意脏值。 */
function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore & {
  data: Record<string, unknown>
} {
  const data = { ...initial }
  return {
    data,
    async get<T>(key: string) {
      return data[key] as T | undefined
    },
    async set<T>(key: string, value: T) {
      data[key] = value
    },
  }
}

async function load(initial: Record<string, unknown> = {}): Promise<PreferenceStore> {
  const store = new PreferenceStore(memoryStore(initial))
  await store.init()
  return store
}

describe('默认值', () => {
  it('什么都没存过时用默认值', async () => {
    expect((await load()).all()).toEqual(DEFAULT_PREFERENCES)
  })

  it('存过的值会被读回来', async () => {
    const store = await load({
      'editor.sourceModeByDefault': true,
      'export.pdf.pageSize': 'Letter',
      'export.pdf.landscape': true,
      'export.pdf.marginInch': 1.25,
    })
    expect(store.all()).toEqual({
      sourceModeByDefault: true,
      pdfPageSize: 'Letter',
      pdfLandscape: true,
      pdfMarginInch: 1.25,
    })
  })
})

describe('坏值不会传染', () => {
  it('类型不对的字段退回默认值，**其余字段照常生效**', async () => {
    // 关键在后半句：一个字段写坏了不该让整份设置作废
    const store = await load({
      'editor.sourceModeByDefault': 'yes',
      'export.pdf.pageSize': 'Letter',
    })
    expect(store.get('sourceModeByDefault')).toBe(false)
    expect(store.get('pdfPageSize')).toBe('Letter')
  })

  it('不认识的纸张退回 A4', async () => {
    expect((await load({ 'export.pdf.pageSize': 'A4 ' })).get('pdfPageSize')).toBe('A4')
    expect((await load({ 'export.pdf.pageSize': 42 })).get('pdfPageSize')).toBe('A4')
    expect((await load({ 'export.pdf.pageSize': null })).get('pdfPageSize')).toBe('A4')
  })

  it('页边距是**夹住**而不是拒绝 —— 0 和很宽都是正当需求', async () => {
    expect((await load({ 'export.pdf.marginInch': 0 })).get('pdfMarginInch')).toBe(0)
    expect((await load({ 'export.pdf.marginInch': 2 })).get('pdfMarginInch')).toBe(2)
    expect((await load({ 'export.pdf.marginInch': -5 })).get('pdfMarginInch')).toBe(0)
    expect((await load({ 'export.pdf.marginInch': 999 })).get('pdfMarginInch')).toBe(3)
  })

  it('页边距不是数字时退回默认值', async () => {
    expect((await load({ 'export.pdf.marginInch': '1.5' })).get('pdfMarginInch')).toBe(0.6)
    expect((await load({ 'export.pdf.marginInch': Number.NaN })).get('pdfMarginInch')).toBe(0.6)
    expect((await load({ 'export.pdf.marginInch': Infinity })).get('pdfMarginInch')).toBe(0.6)
  })

  it('整个文件是垃圾也照常启动', async () => {
    const store = await load({
      'editor.sourceModeByDefault': { nested: true },
      'export.pdf.pageSize': [],
      'export.pdf.landscape': 'true',
      'export.pdf.marginInch': 'wide',
    })
    expect(store.all()).toEqual(DEFAULT_PREFERENCES)
  })
})

describe('写回', () => {
  let backing: ReturnType<typeof memoryStore>
  let store: PreferenceStore

  beforeEach(async () => {
    backing = memoryStore()
    store = new PreferenceStore(backing)
    await store.init()
  })

  it('写进去的值会落到存储里，键名带分组前缀', async () => {
    await store.set('pdfPageSize', 'Legal')
    expect(backing.data['export.pdf.pageSize']).toBe('Legal')
  })

  it('非法值一律挡下来，存储里什么都不留', async () => {
    await store.set('pdfPageSize', 'B5' as never)
    expect(store.get('pdfPageSize')).toBe('A4')
    expect(backing.data['export.pdf.pageSize']).toBeUndefined()
  })

  it('写入前会先夹到合法区间', async () => {
    await store.set('pdfMarginInch', 99)
    expect(store.get('pdfMarginInch')).toBe(3)
    expect(backing.data['export.pdf.marginInch']).toBe(3)
  })

  it('值没变时不写盘 —— 每次打开设置面板都重写一遍纯属噪声', async () => {
    await store.set('pdfPageSize', 'A4')
    expect(backing.data['export.pdf.pageSize']).toBeUndefined()
  })

  it('变化会通知监听者', async () => {
    const seen: boolean[] = []
    store.onChange((prefs) => seen.push(prefs.sourceModeByDefault))
    await store.set('sourceModeByDefault', true)
    await store.set('sourceModeByDefault', true)
    expect(seen).toEqual([true])
  })

  it('恢复默认值会把每一项都写回去', async () => {
    await store.set('pdfPageSize', 'Legal')
    await store.set('sourceModeByDefault', true)
    await store.reset()

    expect(store.all()).toEqual(DEFAULT_PREFERENCES)
    // 逐个写回而不是删键 —— 让用户在 settings.json 里看得见现状
    expect(backing.data['export.pdf.pageSize']).toBe('A4')
    expect(backing.data['editor.sourceModeByDefault']).toBe(false)
  })
})
