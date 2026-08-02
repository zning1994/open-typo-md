/**
 * 代码块的横向滚动。
 *
 * 背景见 docs/design/02-editor-core.md §6.1：代码不能跟着散文一起折行，
 * 但 CodeMirror 把每一行渲染成独立的 `.cm-line`，**没有「代码块」这层 DOM 容器**，
 * 所以「整块一起横向滚动」拿不到现成的。
 *
 * 做法：每行各自 `overflow-x: auto`（样式在 theme.ts 里），再由这个插件把
 * 同一个代码块内所有行的 `scrollLeft` 对齐 —— 视觉上等价于整块一起滚。
 *
 * 「同一个代码块」的判定不靠额外的属性标记，而是靠 DOM 相邻：代码块的行在
 * 文档里是连续的，因此在 DOM 里也是连续的兄弟节点。中间隔着任何非代码行
 * （空行、正文）自然就断开了。
 *
 * ## 为什么光标驱动的滚动必须自己做（issue #2）
 *
 * 第一版只监听 `scroll` 事件。那意味着**只有鼠标滚轮和拖滚动条才会滚** ——
 * 用方向键或查找跳到长行的深处时，行一动不动。实测（1100px 宽窗口，
 * 光标跳到第 61 列）：
 *
 *     代码行 scrollLeft = [0, 0, 0]      ← 一次都没变
 *     光标画在 x=957，而代码块可视范围是 x=238..862
 *
 * 第二个数字是关键：CodeMirror 按**未裁剪**的坐标测光标位置，于是插入符被画到
 * 了代码块右边界外 95px 的空白上。窗口再窄一点，这个块外的幽灵插入符就会把
 * `.cm-scroller` 的 `scrollWidth` 撑开，于是**整个视口跟着横向滚动** ——
 * 标题和正文一起左移，列号大时整页内容被推出屏幕，只剩一小块悬空的高亮。
 *
 * 三个症状（行不滚 / 视口在滚 / 高亮跑到块外）是同一个原因：
 * **没有人把行滚到该滚的位置**。把行滚对之后，光标的真实坐标自然落回块内，
 * 另外两个症状随之消失 —— 不需要分别去治。
 */
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

export const CODE_LINE_CLASS = 'cm-mosu-code-block'

/**
 * 插入符距离代码块边缘的最小留白。
 *
 * 不留的话插入符会紧贴边界，看着像被切掉半根；而且下一个字符一定又要触发
 * 一次滚动，连续输入时块会一格一格地抖。
 */
const CARET_PADDING = 24

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

/** 从任意节点往上找它所属的 `.cm-line`。 */
function lineElementAt(view: EditorView, pos: number): HTMLElement | null {
  let node: Node | null = view.domAtPos(pos).node
  while (node && node !== view.contentDOM) {
    if (node instanceof HTMLElement && node.classList.contains('cm-line')) return node
    node = node.parentNode
  }
  return null
}

/** 一次要写下去的滚动位置。 */
interface ScrollPlan {
  lines: HTMLElement[]
  left: number
}

class CodeBlockScroll implements PluginValue {
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
    this.follow()
  }

  update(update: ViewUpdate): void {
    // 视口变化也要跟：换行导致代码块重新渲染时，DOM 元素是新的，
    // scrollLeft 会归零，而光标还在原处
    if (update.docChanged || update.selectionSet || update.viewportChanged) this.follow()
  }

  /**
   * 把光标所在的代码行滚到「插入符可见」的位置。
   *
   * 走 `requestMeasure` 而不是直接算：读阶段要用 `coordsAtPos`，那需要一次
   * 真实布局；在 update 里直接读会强制同步重排，把每一次按键都变贵。
   */
  private follow(): void {
    this.view.requestMeasure<ScrollPlan | null>({
      read: (view) => {
        const head = view.state.selection.main.head
        const line = lineElementAt(view, head)
        if (!isCodeLine(line)) return null

        const caret = view.coordsAtPos(head)
        if (!caret) return null

        const box = line.getBoundingClientRect()
        // 全部在**渲染后的坐标**里算，所以不需要知道当前 scrollLeft 是多少，
        // 也不需要假设字符等宽（代码块里可能混着 CJK 与连字）
        const padding = Math.min(CARET_PADDING, box.width / 4)
        let delta = 0
        if (caret.left < box.left + padding) delta = caret.left - (box.left + padding)
        else if (caret.right > box.right - padding) delta = caret.right - (box.right - padding)
        if (delta === 0) return null

        const max = Math.max(0, line.scrollWidth - line.clientWidth)
        const left = Math.max(0, Math.min(max, Math.round(line.scrollLeft + delta)))
        if (left === line.scrollLeft) return null
        return { lines: blockLines(line), left }
      },
      write: (plan) => {
        if (!plan) return
        this.apply(plan.lines, plan.left)
      },
    })
  }

  private readonly onScroll = (event: Event): void => {
    if (this.syncing) return
    const target = event.target
    if (!isCodeLine(target instanceof Element ? target : null)) return

    const source = target as HTMLElement
    this.apply(blockLines(source), source.scrollLeft, source)
  }

  /**
   * 把一个代码块里的所有行对齐到同一个 `scrollLeft`。
   *
   * 改完顺手让 CodeMirror 重新测量一次：选区与插入符是 `drawSelection` 画在
   * 独立图层上的绝对定位元素，而这次滚动发生在它的测量之后。实测下来 CM 的
   * 坐标模型**是**认 `line.scrollLeft` 的（插入符位置一直正确），
   * 所以这一下不是必需的，但它让「滚动 → 重绘」这条链路不依赖时序巧合。
   */
  private apply(lines: readonly HTMLElement[], left: number, exclude?: HTMLElement): void {
    this.syncing = true
    let moved = false
    for (const line of lines) {
      if (line !== exclude && line.scrollLeft !== left) {
        line.scrollLeft = left
        moved = true
      }
    }
    if (moved) this.view.requestMeasure()
    requestAnimationFrame(() => {
      this.syncing = false
    })
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll, true)
  }
}

export function codeBlockScrollSync(): Extension {
  return ViewPlugin.fromClass(CodeBlockScroll)
}
