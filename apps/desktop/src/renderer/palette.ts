/**
 * 命令面板。
 *
 * 用裸 DOM 而不是 React：外壳目前只有编辑区 + 状态栏，为一个浮层引入
 * 整套框架不划算。真正需要 React 的是文件树 / 标签页那一层（`@mosu/ui`），
 * 而它已随 M4.5 搁置 —— 届时这个文件会被重写，现在多写的抽象都是浪费。
 *
 * 三条不肯让步的交互约定：
 *
 * - **关掉之后焦点必须回到编辑器。** 焦点丢在 body 上，用户下一次按键就没反应，
 *   而且他不会意识到是面板的锅。
 * - **Esc 与点击遮罩都能关。** 只留一个出口的浮层会让人烦躁。
 * - **上下键在列表里循环，Enter 执行。** 面板的价值就是不碰鼠标。
 */
import { formatBinding, searchCommands, type Command } from './commands.js'
import { t } from './i18n.js'

export interface PaletteOptions {
  /** 每次打开时现取命令表 —— 命令的可用性会随文档状态变化。 */
  commands: () => readonly Command[]
  /** 关闭后把焦点还回去。 */
  restoreFocus: () => void
  /** 当前平台是不是 macOS —— 只影响快捷键怎么显示。 */
  mac: () => boolean
}

export class CommandPalette {
  private readonly root: HTMLElement
  private readonly input: HTMLInputElement
  private readonly list: HTMLElement
  private results: Command[] = []
  private active = 0

  constructor(private readonly options: PaletteOptions) {
    this.root = document.createElement('div')
    this.root.className = 'mosu-palette'
    this.root.hidden = true
    // 浮层对读屏软件应当是一个对话框，否则焦点跑进去之后毫无上下文
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-modal', 'true')
    this.root.setAttribute('aria-label', t('panel.palette.label'))

    const box = document.createElement('div')
    box.className = 'mosu-palette__box'

    this.input = document.createElement('input')
    this.input.className = 'mosu-palette__input'
    this.input.type = 'text'
    this.input.placeholder = t('panel.palette.placeholder')
    this.input.setAttribute('aria-controls', 'mosu-palette-list')
    // 完整的 combobox 模式：焦点始终在输入框，「当前高亮的是哪一项」
    // 靠 aria-activedescendant 告诉读屏软件。少了它，上下键在读屏软件那边
    // 是完全没有反馈的 —— 视觉上有高亮，听觉上什么都没发生
    this.input.setAttribute('role', 'combobox')
    this.input.setAttribute('aria-expanded', 'true')
    this.input.setAttribute('aria-autocomplete', 'list')

    this.list = document.createElement('ul')
    this.list.className = 'mosu-palette__list'
    this.list.id = 'mosu-palette-list'
    this.list.setAttribute('role', 'listbox')
    this.list.setAttribute('aria-label', t('panel.palette.results'))
    // 这个列表会滚动，而滚动区域必须能被键盘够到。它的键盘操作实际在输入框上
    // （上下键 + aria-activedescendant），所以给 -1：可以编程聚焦、不占 Tab 位。
    // 不给的话 axe 的 scrollable-region-focusable 会判违规，而那个判定是对的 ——
    // 一个只能用鼠标滚的区域确实把键盘用户挡在外面了
    this.list.tabIndex = -1

    box.append(this.input, this.list)
    this.root.append(box)
    document.body.append(this.root)

    this.input.addEventListener('input', () => this.refresh())
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event))
    // 点遮罩（而不是面板本体）才关
    this.root.addEventListener('mousedown', (event) => {
      if (event.target === this.root) this.close()
    })
  }

  /** 换语言后补上只写过一次的文案。列表每次打开都重画，不用管。 */
  retranslate(): void {
    this.root.setAttribute('aria-label', t('panel.palette.label'))
    this.list.setAttribute('aria-label', t('panel.palette.results'))
    this.input.placeholder = t('panel.palette.placeholder')
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  open(): void {
    this.root.hidden = false
    this.input.value = ''
    this.refresh()
    this.input.focus()
  }

  close(): void {
    if (!this.isOpen) return
    this.root.hidden = true
    // 焦点必须还回编辑器，否则下一次按键石沉大海
    this.options.restoreFocus()
  }

  private refresh(): void {
    const query = this.input.value.trim()
    const found = searchCommands(this.options.commands(), query)
    this.results = found.map((r) => r.command)
    this.active = 0

    this.list.replaceChildren(
      ...found.map(({ command, hits }, index) => this.renderItem(command, hits, index)),
    )
    if (found.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'mosu-palette__empty'
      empty.textContent = t('panel.palette.empty')
      this.list.append(empty)
    }
    this.syncActive()
  }

  private renderItem(command: Command, hits: number[], index: number): HTMLElement {
    const item = document.createElement('li')
    item.className = 'mosu-palette__item'
    item.setAttribute('role', 'option')
    item.id = `mosu-palette-item-${index}`
    item.dataset['index'] = String(index)

    const label = document.createElement('span')
    label.className = 'mosu-palette__label'
    label.append(...highlight(command.title, hits))
    item.append(label)

    if (command.binding) {
      const key = document.createElement('kbd')
      key.className = 'mosu-palette__key'
      key.textContent = formatBinding(command.binding, this.options.mac())
      item.append(key)
    }

    // 用 mousedown 而不是 click：click 之前输入框会先失焦，
    // 而失焦处理里如果关了面板，这一下点击就落空了
    item.addEventListener('mousedown', (event) => {
      event.preventDefault()
      this.run(index)
    })
    item.addEventListener('mousemove', () => {
      this.active = index
      this.syncActive()
    })
    return item
  }

  private syncActive(): void {
    const items = [...this.list.querySelectorAll<HTMLElement>('.mosu-palette__item')]
    items.forEach((item, index) => {
      const on = index === this.active
      item.classList.toggle('is-active', on)
      item.setAttribute('aria-selected', String(on))
      if (on) {
        item.scrollIntoView({ block: 'nearest' })
        this.input.setAttribute('aria-activedescendant', item.id)
      }
    })
    if (items.length === 0) this.input.removeAttribute('aria-activedescendant')
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      this.run(this.active)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (this.results.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      // 循环而不是卡在两端：列表短的时候来回按上下键很常见
      this.active = (this.active + step + this.results.length) % this.results.length
      this.syncActive()
    }
  }

  private run(index: number): void {
    const command = this.results[index]
    if (!command) return
    // 先关再跑：命令可能自己要抢焦点（比如「查找」会打开搜索框）
    this.close()
    command.run()
  }
}

/** 把命中的字符包成 `<mark>`，其余按原文。 */
function highlight(text: string, hits: number[]): Node[] {
  if (hits.length === 0) return [document.createTextNode(text)]

  const nodes: Node[] = []
  const set = new Set(hits)
  let buffer = ''
  let marked = false

  const flush = (): void => {
    if (!buffer) return
    if (marked) {
      const mark = document.createElement('mark')
      mark.textContent = buffer
      nodes.push(mark)
    } else {
      nodes.push(document.createTextNode(buffer))
    }
    buffer = ''
  }

  for (let i = 0; i < text.length; i++) {
    const on = set.has(i)
    if (on !== marked) {
      flush()
      marked = on
    }
    buffer += text[i]
  }
  flush()
  return nodes
}
