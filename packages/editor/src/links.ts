/**
 * 链接跳转。
 *
 * 从语法树里取链接目标，而不是去读渲染后的 DOM 文本 —— 后者对
 * `[文字](url)` 这种行内链接根本拿不到 URL（显示出来的只有「文字」）。
 *
 * 交互约定：**按住 Ctrl / Cmd 点击**才跳转，普通点击用于定位光标。
 * 这是编辑器该有的默认：在编辑器里，点一下最常见的意图是「把光标放这儿」，
 * 而不是「离开当前应用」。
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { BLOCK_NODES, INLINE_NODES } from '@mosu/markdown'
import { livePreviewConfig } from './config.js'

/**
 * 把自动链接的原文补成可跳转的 URL。
 *
 * GFM 允许省略协议 —— `www.example.com` 和 `someone@example.com` 都是合法写法，
 * 但直接扔给系统浏览器打不开。这里按 GitHub 的规则补齐：
 * 裸域名补 `https://`，邮箱补 `mailto:`。
 *
 * 已经带协议的原样返回，**绝不猜**（`ftp://`、`obsidian://` 之类照传，
 * 挡不挡由 main 侧的协议白名单说了算，见架构 01 §6）。
 */
function normalizeAutolink(raw: string): string {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return raw
  if (raw.includes('@')) return `mailto:${raw}`
  return `https://${raw}`
}

/** 取 pos 处链接的目标地址；不在链接上、或链接没有可解析的目标时返回 null。 */
export function linkTargetAt(state: EditorState, pos: number): string | null {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent!) {
    // GFM 的自动链接在语法树里是一个**光秃秃的 URL 节点**，
    // 不像 CommonMark 的 `<...>` 那样包在 Autolink 里。
    // 所以先认它 —— 但只在它不是别人的目标部分时（那种由外层节点处理）。
    if (node.name === INLINE_NODES.url) {
      const parent = node.parent
      if (!parent || !URL_CONTAINERS.has(parent.name)) {
        return normalizeAutolink(state.doc.sliceString(node.from, node.to).trim())
      }
    }

    if (node.name === INLINE_NODES.link || node.name === INLINE_NODES.autolink) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === INLINE_NODES.url) {
          return state.doc.sliceString(child.from, child.to).trim()
        }
      }
      // 引用式链接的目标在文档别处的定义里，解析它是 M3 语义层的事
      return null
    }
    if (!node.parent) return null
  }
  return null
}

/** 这些节点里的 `URL` 是链接目标，由外层节点自己处理。 */
const URL_CONTAINERS = new Set<string>([
  INLINE_NODES.link,
  INLINE_NODES.image,
  INLINE_NODES.autolink,
  BLOCK_NODES.linkReference,
])

export function linkInteraction(): Extension {
  return [
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const { onOpenLink } = view.state.facet(livePreviewConfig)
        if (!onOpenLink) return false
        if (!(event.metaKey || event.ctrlKey)) return false

        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null) return false

        const url = linkTargetAt(view.state, pos)
        if (!url) return false

        event.preventDefault()
        onOpenLink(url)
        return true
      },
    }),
    // 按住修饰键时把链接显示成可点击的样子，给用户一个「这里能点」的反馈
    EditorView.contentAttributes.of({ 'data-mosu-links': 'modifier-click' }),
  ]
}
