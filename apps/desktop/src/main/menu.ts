/**
 * 原生菜单。
 *
 * 菜单项不直接执行动作，只往渲染进程发一个命令名 —— 具体做什么由渲染进程
 * 决定。这样菜单、快捷键、命令面板（M3）走的是同一条路径，不会出现
 * 「菜单能用但快捷键行为不一样」这种经典分裂。
 *
 * **加速键不写在这里**，从 `shared/keys.ts` 那张表查（`item()` 那个 helper）。
 * 用户改了绑定就重建一遍整个菜单 —— Electron 没有「改一个 accelerator」的
 * 接口，而重建的代价是几毫秒，不值得为它设计增量更新。
 */
import {
  Menu,
  app,
  clipboard,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron'
import {
  EVENTS,
  type ContextMenuRequest,
  type ContextMenuResult,
  type MenuCommand,
} from '../shared/channels.js'
import { DEFAULT_BINDINGS, toAccelerator, type BindingMap } from '../shared/keys.js'
import { createTranslate, type Translate } from '../shared/i18n.js'
import { contextMenuTemplate } from '../shared/context-menu.js'

const isMac = process.platform === 'darwin'

export interface MenuActions {
  /** 新建一个空窗口。窗口级动作由 main 直接执行，不必绕渲染进程一圈。 */
  newWindow: () => void
  /** 当前聚焦的窗口 —— 多窗口下菜单命令必须投递给它，不能有全局单例。 */
  focusedWindow: () => BrowserWindow | null
}

export function buildMenu(
  actions: MenuActions,
  bindings: BindingMap = DEFAULT_BINDINGS,
  /**
   * 文案。默认值让老的两参数调用继续成立（测试里到处都是），
   * 而**真实调用永远显式传**当前语言的那一份 —— 见 index.ts 的 refreshMenu。
   */
  t: Translate = createTranslate('zh-CN'),
): void {
  const send = (command: MenuCommand) => () => {
    actions.focusedWindow()?.webContents.send(EVENTS.menuCommand, command)
  }

  /**
   * 一个命令菜单项。加速键查表得到 —— 表里没有就是没有快捷键，
   * 那也是用户能设置出来的合法状态（把绑定清空）。
   */
  const item = (label: string, command: MenuCommand): MenuItemConstructorOptions => {
    const binding = bindings[command]
    const accelerator = binding ? toAccelerator(binding) : null
    return { label, click: send(command), ...(accelerator ? { accelerator } : {}) }
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about', label: t('menu.app.about', { app: app.name }) },
              // macOS 上「检查更新」历来紧跟「关于」，跟「设置」一样只有这一个
              // 位置 —— 非 mac 平台则在「帮助」里（见下面）。同一个动作出现在
              // 两处，用户会以为它们是两件事
              item(t('menu.help.checkUpdates'), 'help.checkUpdates'),
              { type: 'separator' },
              // macOS 的「设置…」**必须**在应用菜单里，紧跟「关于」。
              //
              // 它原来只挂在「视图」下面，而 macOS 用户找设置只会去这一个地方
              // —— 于是一个装了应用的人可以完全不知道有设置这回事，
              // 连带着「怎么换界面语言」也一起找不到（语言就在设置面板里）。
              // 这是用户报回来的。
              //
              // ⌘, 早就是它的默认绑定了，缺的只是这个入口。
              item(t('menu.view.settings'), 'view.settings'),
              { type: 'separator' },
              { role: 'services', label: t('menu.app.services') },
              { type: 'separator' },
              { role: 'hide', label: t('menu.app.hide', { app: app.name }) },
              { role: 'hideOthers', label: t('menu.app.hideOthers') },
              { role: 'unhide', label: t('menu.app.unhide') },
              { type: 'separator' },
              { role: 'quit', label: t('menu.app.quit', { app: app.name }) },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: t('menu.file'),
      submenu: [
        // 还没有标签页，所以 ⌘N 直接给新窗口 —— 在当前窗口「新建」会把
        // 用户正在写的东西顶掉。M3 加了标签之后 ⌘N 变成新标签、⌘⇧N 变成新窗口
        {
          label: t('menu.file.newWindow'),
          accelerator: 'CmdOrCtrl+N',
          click: () => actions.newWindow(),
        },
        item(t('menu.file.newTab'), 'file.newTab'),
        item(t('menu.file.open'), 'file.open'),
        item(t('menu.file.openFolder'), 'file.openFolder'),
        item(t('menu.file.closeFolder'), 'file.closeFolder'),
        item(t('menu.file.closeTab'), 'file.closeTab'),
        item(t('menu.file.openInNewWindow'), 'file.openInNewWindow'),
        { type: 'separator' },
        item(t('menu.file.save'), 'file.save'),
        item(t('menu.file.saveAll'), 'file.saveAll'),
        item(t('menu.file.saveAs'), 'file.saveAs'),
        { type: 'separator' },
        item(t('menu.file.exportHtml'), 'file.exportHtml'),
        item(t('menu.file.exportPdf'), 'file.exportPdf'),
        { type: 'separator' },
        isMac
          ? { role: 'close', label: t('menu.file.closeWindow') }
          : { role: 'quit', label: t('menu.file.quit') },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.edit.undo') },
        { role: 'redo', label: t('menu.edit.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.edit.cut') },
        { role: 'copy', label: t('menu.edit.copy') },
        { role: 'paste', label: t('menu.edit.paste') },
        { role: 'pasteAndMatchStyle', label: t('menu.edit.pastePlain') },
        { role: 'selectAll', label: t('menu.edit.selectAll') },
        { type: 'separator' },
        item(t('menu.edit.find'), 'edit.find'),
        item(t('menu.edit.findInFiles'), 'edit.findInFiles'),
        { type: 'separator' },
        item(t('menu.edit.copyRichText'), 'edit.copyRichText'),
      ],
    },
    {
      label: t('menu.format'),
      submenu: [
        item(t('menu.format.bold'), 'format.bold'),
        item(t('menu.format.italic'), 'format.italic'),
        item(t('menu.format.code'), 'format.code'),
        { type: 'separator' },
        ...([1, 2, 3, 4, 5, 6] as const).map((level) =>
          item(t('menu.format.heading', { level }), `format.heading.${level}`),
        ),
        item(t('menu.format.paragraph'), 'format.heading.0'),
        { type: 'separator' },
        {
          label: t('menu.table'),
          submenu: [
            item(t('menu.table.insert'), 'table.insert'),
            { type: 'separator' },
            item(t('menu.table.rowAbove'), 'table.rowAbove'),
            item(t('menu.table.rowBelow'), 'table.rowBelow'),
            item(t('menu.table.deleteRow'), 'table.deleteRow'),
            { type: 'separator' },
            item(t('menu.table.columnBefore'), 'table.columnBefore'),
            item(t('menu.table.columnAfter'), 'table.columnAfter'),
            item(t('menu.table.deleteColumn'), 'table.deleteColumn'),
            { type: 'separator' },
            item(t('menu.table.alignLeft'), 'table.align.left'),
            item(t('menu.table.alignCenter'), 'table.align.center'),
            item(t('menu.table.alignRight'), 'table.align.right'),
            item(t('menu.table.alignNone'), 'table.align.none'),
            { type: 'separator' },
            item(t('menu.table.format'), 'table.format'),
          ],
        },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        item(t('menu.view.source'), 'view.toggleSource'),
        item(t('menu.view.focus'), 'view.toggleFocus'),
        item(t('menu.view.typewriter'), 'view.toggleTypewriter'),
        item(t('menu.view.files'), 'view.toggleFiles'),
        item(t('menu.view.nextTab'), 'view.nextTab'),
        item(t('menu.view.prevTab'), 'view.prevTab'),
        item(t('menu.view.outline'), 'view.toggleOutline'),
        // mac 上设置已经在应用菜单里了（见上面），这里不再重复一份 ——
        // 同一个动作在两处出现，用户会以为它们是两件事
        ...(isMac ? [] : [item(t('menu.view.settings'), 'view.settings')]),
        item(t('menu.view.palette'), 'view.commandPalette'),
        item(t('menu.view.quickOpen'), 'view.quickOpen'),
        {
          label: t('menu.theme'),
          submenu: [
            item(t('theme.auto'), 'view.theme.auto'),
            item(t('theme.light'), 'view.theme.light'),
            item(t('theme.dark'), 'view.theme.dark'),
            item(t('theme.sepia'), 'view.theme.sepia'),
            item(t('theme.high-contrast'), 'view.theme.high-contrast'),
            item(t('theme.github'), 'view.theme.github'),
          ],
        },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.view.actualSize') },
        { role: 'zoomIn', label: t('menu.view.zoomIn') },
        { role: 'zoomOut', label: t('menu.view.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.view.fullscreen') },
        ...(app.isPackaged
          ? []
          : ([
              { type: 'separator' },
              { role: 'reload', label: t('menu.view.reload') },
              { role: 'toggleDevTools', label: t('menu.view.devtools') },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      role: 'help',
      label: t('menu.help'),
      submenu: [
        // mac 上它在应用菜单里（macOS 的老规矩），这里就不再放一份
        ...(isMac
          ? []
          : [
              item(t('menu.help.checkUpdates'), 'help.checkUpdates'),
              { type: 'separator' } as MenuItemConstructorOptions,
            ]),
        {
          label: t('menu.help.homepage'),
          click: () => void shell.openExternal('https://github.com/zning1994/mosu'),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 上下文菜单（右键菜单，issues #17 / #18）。
 *
 * ## 为什么用原生 Menu 而不是画一个 DOM 浮层
 *
 * 剪切 / 复制 / 粘贴走的是 Electron 的 **role**，由系统直接作用在聚焦的
 * webContents 上。自己画浮层的话这三项就得自己实现 —— 而「粘贴」在渲染进程里
 * 拿不到系统剪贴板的原始内容（那正是 preload 刻意没有暴露的能力），
 * 绕过去要么开一个新的权限口子，要么行为跟原生菜单不一致。
 *
 * 顺带还白拿了三件事：macOS 上的外观与动画、键盘导航、以及各平台的项序惯例。
 *
 * ## 结果怎么回去
 *
 * 用 `popup` 的 `callback`（菜单关闭时触发）兜底返回 null，而每个自定义项的
 * `click` 抢先把自己的 id 填进去。两者的先后顺序 Electron 没有保证，
 * 所以 callback 里延后一拍再结算 —— 让已经排队的 click 有机会先跑。
 * 用 `settled` 挡住重复结算。
 */
export function popupContextMenu(
  window: BrowserWindow,
  request: ContextMenuRequest,
  t: Translate,
): Promise<ContextMenuResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: ContextMenuResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const pick =
      (result: ContextMenuResult): (() => void) =>
      () =>
        finish(result)

    const template = contextMenuTemplate(request, t, pick, (kind, path) => {
      if (kind === 'copy') clipboard.writeText(path)
      else shell.showItemInFolder(path)
    })

    Menu.buildFromTemplate(template).popup({
      window,
      // 菜单已经关了，但自定义项的 click 可能还排在后面。延后一拍再兜底，
      // 否则用户点了「关闭其他标签页」却拿到 null，什么都不会发生
      callback: () => setImmediate(() => finish(null)),
    })
  })
}
