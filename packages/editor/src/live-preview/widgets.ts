/**
 * 实时预览用到的 widget。
 *
 * 共同约束：
 * - widget 不持有任何编辑状态。所有改动都必须转成对主文档的 transaction
 *   （docs/design/02 §6 的铁律），否则撤销栈会和显示脱节。
 * - 渲染失败必须降级为「显示源码」，不能吞内容（原则 P2）。
 */
import { WidgetType } from '@codemirror/view'

/** 无序列表的项目符号。把 `-` / `*` / `+` 统一显示成 `•`，源码里仍是原字符。 */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-typo-bullet'
    span.textContent = '•'
    // 项目符号是纯装饰，读屏软件应该读列表语义而不是这个字符
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  override ignoreEvent(): boolean {
    return false
  }
}

/** 分隔线。替换掉整行的 `---`。 */
export class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-typo-hr'
    span.setAttribute('role', 'separator')
    return span
  }
  override ignoreEvent(): boolean {
    return false
  }
}

/**
 * 图片。
 *
 * `src` 已经过 AssetResolver 处理（见 ../config.ts）——
 * widget 自己绝不拼 `file://`，路径合法性由宿主把关（docs/design/01 §6）。
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    /** 原始 Markdown 源码，加载失败时显示它，保证内容不被吞掉。 */
    readonly source: string,
  ) {
    super()
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.source === this.source
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-typo-image'

    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    img.addEventListener('error', () => {
      wrap.classList.add('cm-typo-image--broken')
      wrap.textContent = this.source
      wrap.title = `图片无法加载：${this.src}`
    })
    wrap.appendChild(img)
    return wrap
  }

  override ignoreEvent(): boolean {
    // 让点击事件冒泡给编辑器，这样点图片能把光标放到对应源码位置
    return false
  }
}
