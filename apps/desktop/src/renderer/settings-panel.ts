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
import { menuCommandTitle } from './commands.js'
import type { KeybindingStore } from './keybindings.js'
import type { MenuCommand } from '../shared/channels.js'
import { formatBinding, normalizeBinding } from '../shared/keys.js'
import { LOCALES, type LanguageSetting } from '../shared/i18n.js'
import { t } from './i18n.js'

export interface SettingsPanelOptions {
  preferences: PreferenceStore
  keys: KeybindingStore
  /** 有快捷键可配的命令，按显示顺序。 */
  commands: readonly MenuCommand[]
  /**
   * 当前平台是不是 macOS。它决定录制时看 `metaKey` 还是 `ctrlKey`，
   * 认错了的表现是「macOS 上按 ⌘⇧B 录出来是 `Shift+B`」。
   *
   * 写成取值函数而不是布尔快照，是不想让这个判断依赖「谁先初始化」——
   * 平台信息现在是同步可读的（见 preload/index.ts），但那是个容易被后人改掉的
   * 前提，而这里多一层函数的成本是零。
   */
  mac: () => boolean
  /** 当前主题 / 切换主题。主题的归属仍在 ThemeManager，这里只是借个入口。 */
  theme: () => ThemeId
  selectTheme: (theme: ThemeId) => Promise<void>
  /** 当前界面语言设置 / 换一种。跟主题一样，归属在别处，这里只是借个入口。 */
  language: () => LanguageSetting
  selectLanguage: (language: LanguageSetting) => Promise<void>
  /** 关掉之后把焦点还回去。 */
  restoreFocus: () => void
}

/** 浏览器的 `event.key` → 我们那张表认的主键名。 */
const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Esc: 'Escape',
  Del: 'Delete',
}

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock'])

/**
 * 一次 keydown → 一个规范化的绑定；只按了修饰键则返回 null。
 *
 * `metaKey` 在 macOS 上映射成 `Mod`，在其他平台上 `ctrlKey` 才是 —— 记的是
 * 「用户按的那个『主修饰键』」而不是物理键，这样同一份设置换台机器仍然合理。
 *
 * 用 `event.code` 而不是 `event.key` 取字母：按住 ⌥ 时 macOS 的 `key` 会变成
 * 重音符号（⌥+B 是 `∫`），拿它去绑等于绑了个打不出来的东西。
 */
function comboFrom(event: KeyboardEvent, mac: boolean): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null

  const parts: string[] = []
  if (mac ? event.metaKey : event.ctrlKey) parts.push('Mod')
  if (mac && event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  const letter = /^Key([A-Z])$/.exec(event.code)
  const digit = /^Digit(\d)$/.exec(event.code)
  const key = letter?.[1] ?? digit?.[1] ?? KEY_ALIASES[event.key] ?? event.key
  parts.push(key)

  return normalizeBinding(parts.join('+'))
}

/**
 * 纸张名。**只有 Letter 需要翻译** —— 其余是国际通用的规格代号，
 * 翻成本地词反而对不上打印机驱动里的写法。
 */
function pageSizeLabel(size: PageSize): string {
  return size === 'Letter' ? t('settings.pdf.letter') : size
}

export class SettingsPanel {
  private readonly root: HTMLElement
  private readonly body: HTMLElement
  private readonly titleEl: HTMLElement
  private readonly closeEl: HTMLButtonElement
  private readonly resetEl: HTMLButtonElement
  private readonly hintEl: HTMLElement

  constructor(private readonly options: SettingsPanelOptions) {
    this.root = document.createElement('div')
    this.root.className = 'mosu-settings'
    this.root.hidden = true
    // 浮层对读屏软件应当是一个对话框，否则焦点跑进去之后毫无上下文
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-modal', 'true')
    this.root.setAttribute('aria-label', t('settings.title'))

    const box = document.createElement('div')
    box.className = 'mosu-settings__box'

    const header = document.createElement('div')
    header.className = 'mosu-settings__header'
    this.titleEl = document.createElement('h2')
    this.titleEl.className = 'mosu-settings__title'
    this.titleEl.textContent = t('settings.title')
    header.appendChild(this.titleEl)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'mosu-settings__close'
    close.textContent = '×'
    this.closeEl = close
    close.setAttribute('aria-label', t('settings.close'))
    close.addEventListener('click', () => this.hide())
    header.appendChild(close)
    box.appendChild(header)

    this.body = document.createElement('div')
    this.body.className = 'mosu-settings__body'
    box.appendChild(this.body)

    const footer = document.createElement('div')
    footer.className = 'mosu-settings__footer'
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'mosu-settings__reset'
    this.resetEl = reset
    reset.textContent = t('settings.reset')
    reset.addEventListener('click', () => {
      void this.options.preferences.reset().then(() => this.render())
    })
    footer.appendChild(reset)

    const hint = document.createElement('span')
    hint.className = 'mosu-settings__hint'
    this.hintEl = hint
    hint.textContent = t('settings.hint')
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

  /**
   * 换语言后补上外框的文案。
   *
   * 内容区不用管 —— `render()` 每次打开都重画一遍。但这个方法**必须也调
   * `render()`**：用户是在这个面板里换的语言，面板正开着，不重画的话他会看到
   * 一个「标题变了、内容没变」的半吊子状态，然后合理地怀疑设置没生效。
   */
  retranslate(): void {
    this.root.setAttribute('aria-label', t('settings.title'))
    this.titleEl.textContent = t('settings.title')
    this.closeEl.setAttribute('aria-label', t('settings.close'))
    this.resetEl.textContent = t('settings.reset')
    this.hintEl.textContent = t('settings.hint')
    if (this.isOpen()) this.render()
  }

  /**
   * 重画。
   *
   * `focusCommand` 是给录制流程用的：录完一个键之后整块表被重建，
   * 焦点会掉到 body 上 —— 那时 Esc 关不掉面板（键盘事件挂在浮层上），
   * 用户会以为面板卡住了。把焦点还回那一行，顺带还能接着录下一个。
   */
  private render(focusCommand?: MenuCommand): void {
    const prefs = this.options.preferences.all()
    this.body.replaceChildren(
      this.section(t('settings.section.appearance'), [
        this.selectRow(
          t('settings.theme'),
          THEMES.map((theme) => [theme.id, t(`theme.${theme.id}`)] as const),
          this.options.theme(),
          (value) => this.options.selectTheme(value as ThemeId),
        ),
        this.selectRow(
          t('settings.language'),
          [
            ['auto', t('settings.language.auto')] as const,
            // 每种语言用**它自己的名字**列出来，不翻译：看不懂当前界面语言的人
            // 正是最需要找到这一行的人，「日本語」他认得，「Japanese」未必
            ...LOCALES.map((locale) => [locale.id, locale.label] as const),
          ],
          this.options.language(),
          (value) => this.options.selectLanguage(value as LanguageSetting),
          t('settings.language.hint'),
        ),
      ]),
      this.section(t('settings.section.editor'), [
        this.checkRow(
          t('settings.sourceModeByDefault'),
          prefs.sourceModeByDefault,
          t('settings.sourceModeByDefault.hint'),
          (value) => this.options.preferences.set('sourceModeByDefault', value),
        ),
        this.checkRow(
          t('settings.focusMode'),
          prefs.focusMode,
          t('settings.focusMode.hint'),
          (value) => this.options.preferences.set('focusMode', value),
        ),
        this.checkRow(
          t('settings.typewriterMode'),
          prefs.typewriterMode,
          t('settings.typewriterMode.hint'),
          (value) => this.options.preferences.set('typewriterMode', value),
        ),
        this.checkRow(
          t('settings.renderInlineHtml'),
          prefs.renderInlineHtml,
          t('settings.renderInlineHtml.hint'),
          (value) => this.options.preferences.set('renderInlineHtml', value),
        ),
        // 这是整个应用唯一一个会主动对外发请求的开关，所以提示语里把
        // 「什么时候发、发了什么」说清楚 —— 本地优先的工具不该让用户去猜
        this.checkRow(
          t('settings.updates'),
          prefs.checkUpdates,
          t('settings.updates.hint'),
          (value) => this.options.preferences.set('checkUpdates', value),
        ),
      ]),
      this.section(t('settings.section.keys'), [this.keysTable()]),
      this.section(t('settings.section.pdf'), [
        this.selectRow(
          t('settings.pdf.pageSize'),
          PAGE_SIZES.map((size) => [size, pageSizeLabel(size)] as const),
          prefs.pdfPageSize,
          (value) => this.options.preferences.set('pdfPageSize', value as PageSize),
        ),
        this.checkRow(t('settings.pdf.landscape'), prefs.pdfLandscape, '', (value) =>
          this.options.preferences.set('pdfLandscape', value),
        ),
        this.numberRow(t('settings.pdf.margin'), prefs.pdfMarginInch, (value) =>
          this.options.preferences.set('pdfMarginInch', value),
        ),
      ]),
    )

    if (focusCommand) {
      this.body
        .querySelector<HTMLElement>(`.mosu-keys__binding[data-command="${focusCommand}"]`)
        ?.focus()
    }
  }

  /**
   * 快捷键表。
   *
   * 每条命令一行，右边那个按钮点一下进入「录制」状态，直接按你想要的组合。
   * 用输入框而不是让用户敲字符串（「Mod+Shift+K」）的理由很简单：
   * **用户知道自己想按什么，未必知道该怎么拼它。**
   */
  private keysTable(): HTMLElement {
    const table = document.createElement('div')
    table.className = 'mosu-keys'

    const conflicts = this.options.keys.conflicts()

    for (const command of this.options.commands) {
      const binding = this.options.keys.get(command)
      const row = document.createElement('div')
      row.className = 'mosu-keys__row'

      const label = document.createElement('span')
      label.className = 'mosu-keys__label'
      label.textContent = menuCommandTitle(command)
      row.appendChild(label)

      // 撞车只警告不阻止：两个命令共用一个键在别的应用里也常见（上下文不同时
      // 各自生效），我们判断不了用户的上下文，所以只把事实摆出来
      if (binding && (conflicts.get(binding)?.length ?? 0) > 1) {
        const warn = document.createElement('span')
        warn.className = 'mosu-keys__conflict'
        warn.textContent = t('settings.keys.conflict')
        warn.title = (conflicts.get(binding) ?? [])
          .map((id) => menuCommandTitle(id))
          .join(' / ')
        row.appendChild(warn)
      }

      row.appendChild(this.captureButton(command, binding))

      const clear = document.createElement('button')
      clear.type = 'button'
      clear.className = 'mosu-keys__clear'
      clear.textContent = '×'
      clear.title = t('settings.keys.clear')
      clear.addEventListener('click', () => {
        void this.options.keys.set(command, '').then(() => this.render())
      })
      row.appendChild(clear)

      table.appendChild(row)
    }

    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'mosu-keys__reset'
    reset.textContent = t('settings.keys.reset')
    reset.addEventListener('click', () => {
      void this.options.keys.reset(this.options.commands).then(() => this.render())
    })
    table.appendChild(reset)

    return table
  }

  /**
   * 录制按钮。
   *
   * 录制期间**吞掉所有按键**（`preventDefault` + `stopPropagation`）——
   * 否则你按 ⌘S 想绑它，结果文档存了一次。修饰键单独按下不算数：
   * 光按住 ⌘ 不构成一个绑定，得等到真正的主键落下。
   */
  private captureButton(command: MenuCommand, binding: string | undefined): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mosu-keys__binding'
    button.dataset['command'] = command
    button.textContent = binding
      ? formatBinding(binding, this.options.mac())
      : t('settings.keys.unset')
    if (!binding) button.classList.add('mosu-keys__binding--empty')

    let capturing = false
    const stop = (): void => {
      capturing = false
      button.classList.remove('mosu-keys__binding--capturing')
      button.textContent = binding
        ? formatBinding(binding, this.options.mac())
        : t('settings.keys.unset')
    }

    button.addEventListener('click', () => {
      capturing = true
      button.classList.add('mosu-keys__binding--capturing')
      button.textContent = t('settings.keys.recording')
      button.focus()
    })
    button.addEventListener('blur', stop)

    button.addEventListener('keydown', (event) => {
      if (!capturing) return
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        stop()
        return
      }

      const captured = comboFrom(event, this.options.mac())
      // 只按住修饰键还不算一个绑定，继续等
      if (!captured) return

      void this.options.keys.set(command, captured).then((ok) => {
        if (!ok) {
          button.textContent = t('settings.keys.rejected')
          return
        }
        this.render(command)
      })
    })

    return button
  }

  private section(title: string, rows: HTMLElement[]): HTMLElement {
    const section = document.createElement('section')
    section.className = 'mosu-settings__section'
    const heading = document.createElement('h3')
    heading.className = 'mosu-settings__section-title'
    heading.textContent = title
    section.append(heading, ...rows)
    return section
  }

  private row(label: string, control: HTMLElement, note = ''): HTMLElement {
    const row = document.createElement('label')
    row.className = 'mosu-settings__row'

    const text = document.createElement('span')
    text.className = 'mosu-settings__label'
    text.textContent = label
    if (note) {
      const small = document.createElement('small')
      small.className = 'mosu-settings__note'
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
    note = '',
  ): HTMLElement {
    const select = document.createElement('select')
    select.className = 'mosu-settings__control'
    for (const [value, text] of options) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = text
      select.appendChild(option)
    }
    select.value = current
    select.addEventListener('change', () => void onChange(select.value))
    return this.row(label, select, note)
  }

  private checkRow(
    label: string,
    current: boolean,
    note: string,
    onChange: (value: boolean) => Promise<void>,
  ): HTMLElement {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'mosu-settings__control mosu-settings__check'
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
    input.className = 'mosu-settings__control mosu-settings__number'
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
