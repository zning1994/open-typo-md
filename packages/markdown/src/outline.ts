/**
 * 从语法树派生的文档信息（大纲、字数）。
 *
 * 遵循架构 01 §7：任何能从文档文本推导出来的东西都不进 store，
 * 现算或缓存在 StateField 里。这里提供纯函数，不依赖 CodeMirror 的 EditorState，
 * 因此可以脱离编辑器单测。
 */
import type { Tree } from '@lezer/common'
import { headingLevel } from './nodes.js'

export interface OutlineItem {
  level: number
  text: string
  from: number
  to: number
}

/** 读取文档某段文本的接口 —— 用它就不必把 CodeMirror 的 Text 类型带进来。 */
export type TextSlice = (from: number, to: number) => string

const ATX_PREFIX = /^\s*#{1,6}\s*/
const ATX_SUFFIX = /\s+#*\s*$/
const SETEXT_UNDERLINE = /\n[=-]+\s*$/

export function extractOutline(tree: Tree, slice: TextSlice): OutlineItem[] {
  const items: OutlineItem[] = []
  tree.iterate({
    enter(node) {
      const level = headingLevel(node.name)
      if (level === 0) return
      const raw = slice(node.from, node.to)
      const text = raw
        .replace(SETEXT_UNDERLINE, '')
        .replace(ATX_PREFIX, '')
        .replace(ATX_SUFFIX, '')
        .trim()
      items.push({ level, text, from: node.from, to: node.to })
      return false // 标题内部不会再有标题，不必下钻
    },
  })
  return items
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/

/**
 * 字数统计。
 *
 * 中日韩按字符计，拉丁语按空白分词计 —— 这是中文用户对「字数」的预期，
 * 也是同类编辑器的通行做法。两者混排时分别累加。
 */
export function countWords(text: string): { words: number; characters: number } {
  const characters = [...text].length
  let words = 0
  let inWord = false
  for (const ch of text) {
    if (CJK.test(ch)) {
      words++
      inWord = false
    } else if (/\s/.test(ch)) {
      inWord = false
    } else if (!inWord) {
      words++
      inWord = true
    }
  }
  return { words, characters }
}
