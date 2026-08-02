/**
 * Mermaid 图表：把 ```` ```mermaid ```` 围栏渲染成图。
 *
 * ## 懒加载是硬要求，不是优化
 *
 * Mermaid 压缩后接近 3MB —— 比编辑器内核本身还大好几倍。它只能在文档里
 * **真的出现**一个 mermaid 围栏时才加载。跟 KaTeX 一样切成独立 chunk。
 *
 * ## 三个必须处理的集成细节
 *
 * 1. **`startOnLoad: false`。** 默认它会自己扫描整个页面找 `.mermaid` 元素并
 *    就地改写 DOM —— 在 CodeMirror 里那等于让第三方库直接改我们的渲染树。
 * 2. **`suppressErrorRendering: true`。** 语法出错时 mermaid 默认会往
 *    `document.body` 上塞一个错误 SVG。那个元素不归编辑器管、也不会被清理，
 *    用户改一次错一次，页面底部就攒一堆。关掉它，自己接住异常显示源码。
 * 3. **每次渲染换一个 id。** mermaid 用 id 建临时 DOM，重复 id 会互相踩。
 *
 * ## 主题
 *
 * 跟随亮/暗模式（`prefers-color-scheme`），但**只在加载时读一次** ——
 * mermaid 的主题是全局配置，中途切换需要把所有图重渲染一遍。
 * 系统主题切换是低频事件，这个成本不值得为它常驻一套失效逻辑；
 * M4 的主题引擎接管配色时会一并处理。
 */
import { EditorView, WidgetType } from '@codemirror/view'
import { revealOnClick } from './live-preview/widgets.js'

type MermaidModule = typeof import('mermaid')

let mermaidPromise: Promise<MermaidModule | null> | null = null
let mermaidReady: MermaidModule | null = null
let nextId = 0

function loadMermaid(): Promise<MermaidModule | null> {
  mermaidPromise ??= (async () => {
    try {
      const loaded = await import('mermaid')
      loaded.default.initialize({
        startOnLoad: false,
        suppressErrorRendering: true,
        // 文档内容不可信：图里的标签可能来自任何地方，禁止其中的 HTML 与脚本
        securityLevel: 'strict',
        theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
        fontFamily: 'inherit',
      })
      mermaidReady = loaded
      return loaded
    } catch (error) {
      console.warn('[mosu] Mermaid 加载失败，图表将按源码显示：', error)
      return null
    }
  })()
  return mermaidPromise
}

/**
 * 把一段 mermaid 源码渲染成 SVG 字符串。
 *
 * 导出管线要用它。**刻意复用编辑器这份实例**而不是让导出层自己再加载一次：
 * mermaid 的配置（主题、securityLevel）是全局的，两份实例意味着导出的图
 * 跟屏幕上看到的可能长得不一样。
 *
 * 渲染不出来返回 null，由调用方决定退化行为（导出那边会保留代码块）。
 */
export async function renderMermaid(code: string): Promise<string | null> {
  const mermaid = mermaidReady ?? (await loadMermaid())
  if (!mermaid) return null
  try {
    const { svg } = await mermaid.default.render(`mosu-mermaid-${nextId++}`, code)
    return svg
  } catch {
    return null
  }
}

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super()
  }

  override eq(other: MermaidWidget): boolean {
    // 比内容：图没变就复用，避免每敲一个字重画一次（mermaid 渲染并不便宜）
    return other.code === this.code
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement('div')
    host.className = 'cm-mosu-mermaid'
    revealOnClick(view, host)
    // 还没画出来之前先显示源码。留白会让人以为编辑器卡住了
    host.classList.add('cm-mosu-mermaid--pending')
    host.textContent = this.code

    void this.draw(host)
    return host
  }

  private async draw(host: HTMLElement): Promise<void> {
    const mermaid = mermaidReady ?? (await loadMermaid())
    if (!mermaid) return

    try {
      const { svg } = await mermaid.default.render(`mosu-mermaid-${nextId++}`, this.code)
      host.classList.remove('cm-mosu-mermaid--pending', 'cm-mosu-mermaid--broken')
      // mermaid 的输出是它自己生成的 SVG 字符串，且已按 securityLevel: 'strict'
      // 过滤过标签内容；这里不再做二次解析
      host.innerHTML = svg
    } catch (error) {
      // 图写错了：显示源码 + 一条说明。绝不留白，也绝不把异常抛给装饰层
      host.classList.add('cm-mosu-mermaid--broken')
      host.classList.remove('cm-mosu-mermaid--pending')
      host.textContent = this.code
      host.title = error instanceof Error ? error.message : String(error)
    }
  }

  override ignoreEvent(event: Event): boolean {
    // mousedown 我们自己处理（把光标放进图的源码里），其余交给编辑器
    return event.type === 'mousedown'
  }
}

export const mermaidTheme = EditorView.theme({
  '.cm-mosu-mermaid': {
    display: 'block',
    textAlign: 'center',
    margin: '0.8em 0',
    padding: '0.6em',
    overflowX: 'auto',
  },
  '.cm-mosu-mermaid svg': {
    maxWidth: '100%',
    height: 'auto',
  },
  '.cm-mosu-mermaid--pending, .cm-mosu-mermaid--broken': {
    fontFamily: 'var(--mosu-font-mono, ui-monospace, Menlo, Consolas, monospace)',
    fontSize: '0.9em',
    textAlign: 'left',
    whiteSpace: 'pre',
    color: 'var(--mosu-fg-muted, #6e7781)',
  },
  '.cm-mosu-mermaid--broken': {
    color: 'var(--mosu-danger, #cf222e)',
    textDecoration: 'underline wavy',
  },
})
