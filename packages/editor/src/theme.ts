/**
 * 内核自带的基础样式。
 *
 * 定位：只负责「结构性」的呈现（标题多大、引用有条边线、代码块有底色），
 * 一切颜色和字体都走 CSS 变量，由主题层覆盖（docs/design/05）。
 * M4 的主题引擎会接管配色，这里的默认值只是让 M1 能看。
 */
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

const v = (name: string, fallback: string) => `var(--typo-${name}, ${fallback})`

export const baseTheme = EditorView.theme({
  '&': {
    color: v('fg', '#24292f'),
    backgroundColor: v('bg', '#ffffff'),
    fontSize: v('font-size', '16px'),
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: v('font-body', 'system-ui, -apple-system, "PingFang SC", sans-serif'),
    lineHeight: v('line-height', '1.7'),
    overflow: 'auto',
  },
  '.cm-content': {
    maxWidth: v('content-width', '42em'),
    margin: '0 auto',
    padding: '3rem 1.5rem 40vh 1.5rem',
    caretColor: v('cursor', '#24292f'),
  },
  '.cm-line': { padding: '0' },

  // —— 标题 ——
  '.cm-typo-heading': { fontWeight: '600', lineHeight: '1.3' },
  '.cm-typo-h1': { fontSize: '1.9em', margin: '0.9em 0 0.4em' },
  '.cm-typo-h2': { fontSize: '1.55em', margin: '0.85em 0 0.35em' },
  '.cm-typo-h3': { fontSize: '1.3em', margin: '0.8em 0 0.3em' },
  '.cm-typo-h4': { fontSize: '1.12em', margin: '0.75em 0 0.3em' },
  '.cm-typo-h5': { fontSize: '1em', margin: '0.7em 0 0.3em' },
  '.cm-typo-h6': {
    fontSize: '0.94em',
    color: v('fg-muted', '#6e7781'),
    margin: '0.7em 0 0.3em',
  },

  // —— 行内 ——
  '.cm-typo-strong': { fontWeight: '700' },
  '.cm-typo-em': { fontStyle: 'italic' },
  '.cm-typo-strike': { textDecoration: 'line-through', opacity: '0.7' },
  '.cm-typo-code-inline': {
    fontFamily: v('font-mono', 'ui-monospace, Menlo, Consolas, monospace'),
    fontSize: '0.92em',
    backgroundColor: v('code-bg', '#f0f2f4'),
    borderRadius: '4px',
    padding: '0.1em 0.32em',
  },
  '.cm-typo-link': { color: v('accent', '#0969da'), textDecoration: 'underline' },

  // 显形中的 Markdown 标记：看得见，但不抢戏
  '.cm-typo-mark': { color: v('marker-fg', '#b0b6bd'), fontWeight: 'normal' },
  '.cm-typo-list-number': { color: v('marker-fg', '#b0b6bd') },
  '.cm-typo-bullet': { color: v('marker-fg', '#b0b6bd') },

  // —— 块级 ——
  '.cm-typo-quote': {
    borderLeft: `3px solid ${v('border', '#d0d7de')}`,
    paddingLeft: '1em',
    color: v('fg-muted', '#6e7781'),
  },
  '.cm-typo-code-block': {
    fontFamily: v('font-mono', 'ui-monospace, Menlo, Consolas, monospace'),
    fontSize: '0.9em',
    backgroundColor: v('code-bg', '#f0f2f4'),
  },
  '.cm-typo-hr-line': { display: 'flex', alignItems: 'center', minHeight: '1.7em' },
  '.cm-typo-hr': {
    display: 'inline-block',
    width: '100%',
    borderTop: `1px solid ${v('border', '#d0d7de')}`,
    verticalAlign: 'middle',
  },

  // —— 图片 ——
  '.cm-typo-image img': { maxWidth: '100%', borderRadius: '4px', verticalAlign: 'bottom' },
  '.cm-typo-image--broken': {
    fontFamily: v('font-mono', 'monospace'),
    fontSize: '0.9em',
    color: v('danger', '#cf222e'),
    textDecoration: 'underline wavy',
  },
  '.cm-typo-image-source': { color: v('fg-muted', '#6e7781') },

  '.cm-selectionBackground, ::selection': { backgroundColor: v('selection', '#b4d5fe') },
  '.cm-focused .cm-selectionBackground': { backgroundColor: v('selection', '#b4d5fe') },

  // 无障碍：尊重系统的「减少动态效果」设置（docs/design/07 §3）
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-scroller': { scrollBehavior: 'auto' },
  },
})

/**
 * 语法高亮 —— 主要服务于源码模式与代码块内部。
 * 实时预览下大部分行内样式已由装饰接管，这里只补没被装饰覆盖的部分。
 */
export const markdownHighlight = HighlightStyle.define([
  { tag: tags.processingInstruction, color: v('marker-fg', '#b0b6bd') },
  { tag: tags.keyword, color: v('accent', '#0969da') },
  { tag: tags.comment, color: v('fg-muted', '#6e7781'), fontStyle: 'italic' },
  { tag: tags.string, color: v('string-fg', '#0a3069') },
  { tag: tags.number, color: v('number-fg', '#0550ae') },
  { tag: tags.typeName, color: v('type-fg', '#953800') },
  { tag: tags.variableName, color: v('fg', '#24292f') },
  { tag: tags.url, color: v('accent', '#0969da') },
])

export function typoTheme(): Extension {
  return [baseTheme, syntaxHighlighting(markdownHighlight)]
}
