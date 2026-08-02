/**
 * 代码块的横向滚动同步。
 *
 * 背景见 docs/design/02-editor-core.md §6.1：代码不能跟着散文一起折行，
 * 但 CodeMirror 把每一行渲染成独立的 `.cm-line`，**没有「代码块」这层 DOM 容器**，
 * 所以「整块一起横向滚动」拿不到现成的。
 *
 * 折中方案：每行各自 `overflow-x: auto`（样式在 theme.ts 里），
 * 再用这个插件把同一个代码块内所有行的 `scrollLeft` 对齐 ——
 * 视觉上等价于整块一起滚，成本只有几十行，也不用把代码块拖进 widget 的双态模型。
 *
 * 「同一个代码块」的判定不靠额外的属性标记，而是靠 DOM 相邻：
 * 代码块的行在文档里是连续的，因此在 DOM 里也是连续的兄弟节点。
 * 中间隔着任何非代码行（空行、正文）自然就断开了。
 */
import { EditorView, ViewPlugin, type PluginValue } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

export const CODE_LINE_CLASS = 'cm-mosu-code-block'

function isCodeLine(node: Element | null): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains(CODE_LINE_CLASS)
}

/** 与 `from` 处于同一个代码块的全部行（含它自己）。 */
function blockLines(from: HTMLElement): HTMLElement[] {
  const lines = [from]
  for (let el = from.previousElementSibling; isCodeLine(el); el = el.previousElementSibling) {
    lines.push(el)
  }
  for (let el = from.nextElementSibling; isCodeLine(el); el = el.nextElementSibling) {
    lines.push(el)
  }
  return lines
}

class CodeBlockScrollSync implements PluginValue {
  /**
   * 防重入。
   *
   * 注意不能在循环结束后同步复位 —— 浏览器的 scroll 事件是**异步**派发的，
   * 那时标志早就被清掉了，于是我们自己设置的 scrollLeft 又会触发一轮同步。
   * 所以放到下一帧再清。
   */
  private syncing = false

  constructor(private readonly view: EditorView) {
    // scroll 事件不冒泡，但可以在捕获阶段被祖先节点接住
    this.view.scrollDOM.addEventListener('scroll', this.onScroll, true)
  }

  private readonly onScroll = (event: Event): void => {
    if (this.syncing) return
    const target = event.target
    if (!isCodeLine(target instanceof Element ? target : null)) return

    const source = target as HTMLElement
    const left = source.scrollLeft

    this.syncing = true
    for (const line of blockLines(source)) {
      if (line !== source && line.scrollLeft !== left) line.scrollLeft = left
    }
    requestAnimationFrame(() => {
      this.syncing = false
    })
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll, true)
  }
}

export function codeBlockScrollSync(): Extension {
  return ViewPlugin.fromClass(CodeBlockScrollSync)
}
