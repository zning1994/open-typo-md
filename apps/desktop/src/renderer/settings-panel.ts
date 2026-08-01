/**
 * 设置面板（docs/design/05 §4）。
 *
 * 跟命令面板一样是**当前窗口里的浮层**，不是另开一个窗口。开窗口意味着再来一份
 * 渲染进程入口、一套自己的主题初始化、一条跨窗口同步设置的通路 ——
 * 而设置项现在只有六条，那些管道比它们要装的东西还重。
 *
 * 交互沿用命令面板那三条：Esc 与点遮罩都能关，关掉之后焦点回编辑器
 * （焦点丢在 body 上，用户下一次按键就没反应，而且他不会意识到是浮层的锅）。
 *
 * ## 改一下就存一下，没有「确定 / 取消」
 *
 * 设置项之间没有依赖，也没有「一批改动要一起生效」的语义。给一个确定按钮只会
 * 多出一种状态（改了但没提交），以及一个必须回答的问题：关掉浮层算确定还是算取消。
 * 立即生效则一目了然 —— 主题在你点下去的那一刻就变了。
 */
import { THEMES, type ThemeId } from './theme.js'
import { PAGE_SIZES, type PageSize, type PreferenceStore } from './preferences.js'

export interface SettingsPanelOptions {
  preferences: PreferenceStore
  /** 当前主题 / 切换主题。主题的归属仍在 ThemeManager，这里只是借个入口。 */
  theme: () => ThemeId
  selectTheme: (theme: ThemeId) => Promise<void>
  /** 关掉之后把焦点还回去。 */
  restoreFocus: () => void
}

const PAGE_SIZE_LABELS: Record<PageSize, string> = {
  A4: 'A4',
  Letter: 'Letter（美制信纸）',
  Legal: 'Legal',
  A3: 'A3',
  Tabloid: 'Tabloid',
}

export class SettingsPanel {
  private readonly root: HTMLElement
  private readonly body: HTMLElement

  constructor(private readonly options: SettingsPanelOptions) {
    this.root = document.createElement('div')
    this.root.className = 'typo-settings'
    this.root.hidden = true
    // 浮层对读屏软件应当是一个对话框，否则焦点跑进去之后毫无上下文
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-modal', 'true')
    this.root.setAttribute('aria-label', '设置')

    const box = document.createElement('div')
    box.className = 'typo-settings__box'

    const header = document.createElement('div')
    header.className = 'typo-settings__header'
    const title = document.createElement('h2')
    title.className = 'typo-settings__title'
    title.textContent = '设置'
    header.appendChild(title)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'typo-settings__close'
    close.textContent = '×'
    close.setAttribute('aria-label', '关闭设置')
    close.addEventListener('click', () => this.hide())
    header.appendChild(close)
    box.appendChild(header)

    this.body = document.createElement('div')
    this.body.className = 'typo-settings__body'
    box.appendChild(this.body)

    const footer = document.createElement('div')
    footer.className = 'typo-settings__footer'
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'typo-settings__reset'
    reset.textContent = '恢复默认值'
    reset.addEventListener('click', () => {
      void this.options.preferences.reset().then(() => this.render())
    })
    footer.appendChild(reset)

    const hint = document.createElement('span')
    hint.className = 'typo-settings__hint'
    hint.textContent = '改动立即生效'
    footer.appendChild(hint)
    box.appendChild(footer)

    this.root.appendChild(box)

    // 点遮罩关闭；点到面板本身不关
    this.root.addEventListener('mousedown', (event) => {
      if (event.target === this.root) this.hide()
    })
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.hide()
      }
    })

    document.body.appendChild(this.root)
  }

  toggle(): void {
    if (this.root.hidden) this.show()
    else this.hide()
  }

  show(): void {
    this.render()
    this.root.hidden = false
    this.root.querySelector<HTMLElement>('select, input, button')?.focus()
  }

  hide(): void {
    if (this.root.hidden) return
    this.root.hidden = true
    this.options.restoreFocus()
  }

  isOpen(): boolean {
    return !this.root.hidden
  }

  private render(): void {
    const prefs = this.options.preferences.all()
    this.body.replaceChildren(
      this.section('外观', [
        this.selectRow(
          '主题',
          THEMES.map((t) => [t.id, t.label] as const),
          this.options.theme(),
          (value) => this.options.selectTheme(value as ThemeId),
        ),
      ]),
      this.section('编辑器', [
        this.checkRow(
          '新标签页默认进源码模式',
          prefs.sourceModeByDefault,
          '只影响新打开的标签，不动已经开着的那些',
          (value) => this.options.preferences.set('sourceModeByDefault', value),
        ),
        this.checkRow(
          '渲染行内 HTML',
          prefs.renderInlineHtml,
          '只认不带属性的 <b> <em> <u> <s> <sub> <sup> <kbd> <mark> <br>，其余按原文显示',
          (value) => this.options.preferences.set('renderInlineHtml', value),
        ),
      ]),
      this.section('导出 PDF', [
        this.selectRow(
          '纸张',
          PAGE_SIZES.map((size) => [size, PAGE_SIZE_LABELS[size]] as const),
          prefs.pdfPageSize,
          (value) => this.options.preferences.set('pdfPageSize', value as PageSize),
        ),
        this.checkRow('横向', prefs.pdfLandscape, '', (value) =>
          this.options.preferences.set('pdfLandscape', value),
        ),
        this.numberRow('页边距（英寸）', prefs.pdfMarginInch, (value) =>
          this.options.preferences.set('pdfMarginInch', value),
        ),
      ]),
    )
  }

  private section(title: string, rows: HTMLElement[]): HTMLElement {
    const section = document.createElement('section')
    section.className = 'typo-settings__section'
    const heading = document.createElement('h3')
    heading.className = 'typo-settings__section-title'
    heading.textContent = title
    section.append(heading, ...rows)
    return section
  }

  private row(label: string, control: HTMLElement, note = ''): HTMLElement {
    const row = document.createElement('label')
    row.className = 'typo-settings__row'

    const text = document.createElement('span')
    text.className = 'typo-settings__label'
    text.textContent = label
    if (note) {
      const small = document.createElement('small')
      small.className = 'typo-settings__note'
      small.textContent = note
      text.appendChild(small)
    }

    row.append(text, control)
    return row
  }

  private selectRow(
    label: string,
    options: readonly (readonly [string, string])[],
    current: string,
    onChange: (value: string) => Promise<void>,
  ): HTMLElement {
    const select = document.createElement('select')
    select.className = 'typo-settings__control'
    for (const [value, text] of options) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = text
      select.appendChild(option)
    }
    select.value = current
    select.addEventListener('change', () => void onChange(select.value))
    return this.row(label, select)
  }

  private checkRow(
    label: string,
    current: boolean,
    note: string,
    onChange: (value: boolean) => Promise<void>,
  ): HTMLElement {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'typo-settings__control typo-settings__check'
    input.checked = current
    input.addEventListener('change', () => void onChange(input.checked))
    return this.row(label, input, note)
  }

  private numberRow(
    label: string,
    current: number,
    onChange: (value: number) => Promise<void>,
  ): HTMLElement {
    const input = document.createElement('input')
    input.type = 'number'
    input.className = 'typo-settings__control typo-settings__number'
    input.min = '0'
    input.max = '3'
    input.step = '0.1'
    input.value = String(current)
    // 用 change 而不是 input：边敲边存会把 "0."、"" 这类中间状态也写进去
    input.addEventListener('change', () => {
      const value = Number(input.value)
      if (Number.isFinite(value)) void onChange(value)
      // 存进去的值会被夹到合法区间，回显要跟上，否则输入框里留着一个假数字
      queueMicrotask(() => {
        input.value = String(this.options.preferences.get('pdfMarginInch'))
      })
    })
    return this.row(label, input)
  }
}
