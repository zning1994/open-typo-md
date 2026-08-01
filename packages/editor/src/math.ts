/**
 * 数学公式的渲染（KaTeX）。
 *
 * ## 为什么是懒加载
 *
 * KaTeX 连字体在内接近 1MB。绝大多数 Markdown 文档里一个公式都没有，
 * 让所有人为此多等一次加载不合理。所以**第一次真的遇到公式时才 import** ——
 * Vite 会把它切成独立 chunk，主 bundle 不受影响。
 *
 * 代价是 widget 的 `toDOM` 是同步的，而加载是异步的。处理方式：先画一个
 * 占位（就是公式源码本身），加载完成后原地替换。用户看到的是「源码闪一下
 * 变成公式」，而不是一片空白 —— 空白会让人以为编辑器坏了。
 *
 * ## 渲染失败怎么办
 *
 * `throwOnError: false`：KaTeX 会把无法解析的部分以红色原样渲染出来。
 * 这正好是原则 P2 想要的 —— 公式写错时用户看到的是自己写的东西加一个错误提示，
 * 而不是一片空白或者一个异常。
 */
import { EditorView, WidgetType } from '@codemirror/view'
import { revealOnClick } from './live-preview/widgets.js'

type KatexModule = typeof import('katex')

let katexPromise: Promise<KatexModule | null> | null = null
/**
 * 加载完成后缓存下来，供后续 widget **同步**渲染。
 *
 * 没有这一份的话，同一篇文档里每个公式都要先闪一次源码占位 ——
 * 加载其实早就完成了，闪的是异步链路本身。
 */
let katexReady: KatexModule | null = null

/**
 * 加载 KaTeX，只加载一次。
 *
 * 失败返回 null 而不是抛错：没网、chunk 损坏、被安全策略拦下 ——
 * 这些情况下公式应该退化成源码显示，而不是让整个装饰层崩掉。
 */
function loadKatex(): Promise<KatexModule | null> {
  katexPromise ??= (async () => {
    try {
      // 样式和字体一起走懒加载，不进主 CSS
      await import('katex/dist/katex.min.css')
      const loaded = await import('katex')
      katexReady = loaded
      return loaded
    } catch (error) {
      console.warn('[typo] KaTeX 加载失败，公式将按源码显示：', error)
      return null
    }
  })()
  return katexPromise
}

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super()
  }

  override eq(other: MathWidget): boolean {
    // 比内容而不是位置：内容没变就复用，避免每敲一个字整块重新渲染
    return other.tex === this.tex && other.display === this.display
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement(this.display ? 'div' : 'span')
    host.className = this.display ? 'cm-typo-math cm-typo-math--block' : 'cm-typo-math'
    revealOnClick(view, host)

    if (katexReady) {
      render(katexReady, host, this.tex, this.display)
      return host
    }

    // 还没加载好：先显示源码。空白会让人以为编辑器坏了
    host.classList.add('cm-typo-math--pending')
    host.textContent = this.tex

    void loadKatex().then((katex) => {
      if (!katex) return
      // widget 可能已经被销毁（用户继续编辑了），此时 host 是游离节点，
      // 写进去无害；不写反而要多一套失效检查
      host.classList.remove('cm-typo-math--pending')
      render(katex, host, this.tex, this.display)
    })

    return host
  }

  override ignoreEvent(event: Event): boolean {
    // mousedown 我们自己处理（把光标放进公式里），其余交给编辑器
    return event.type === 'mousedown'
  }
}

function render(katex: KatexModule, host: HTMLElement, tex: string, display: boolean): void {
  katex.default.render(tex, host, {
    displayMode: display,
    // 见文件头：写错的公式原样标红显示，不抛错、不留白
    throwOnError: false,
    output: 'html',
  })
}

/** 公式在编辑器里的基础样式。颜色一律走变量，主题层可以覆盖。 */
export const mathTheme = EditorView.theme({
  '.cm-typo-math--block': {
    display: 'block',
    textAlign: 'center',
    margin: '0.8em 0',
    overflowX: 'auto',
  },
  '.cm-typo-math--pending': {
    fontFamily: 'var(--typo-font-mono, ui-monospace, Menlo, Consolas, monospace)',
    color: 'var(--typo-fg-muted, #6e7781)',
  },
  // KaTeX 自己会把错误标红，这里只是让它跟主题的危险色一致
  '.cm-typo-math .katex-error': {
    color: 'var(--typo-danger, #cf222e)',
  },
})
