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
import { Menu, app, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { EVENTS, type MenuCommand } from '../shared/channels.js'
import { DEFAULT_BINDINGS, toAccelerator, type BindingMap } from '../shared/keys.js'

const isMac = process.platform === 'darwin'

export interface MenuActions {
  /** 新建一个空窗口。窗口级动作由 main 直接执行，不必绕渲染进程一圈。 */
  newWindow: () => void
  /** 当前聚焦的窗口 —— 多窗口下菜单命令必须投递给它，不能有全局单例。 */
  focusedWindow: () => BrowserWindow | null
}

export function buildMenu(actions: MenuActions, bindings: BindingMap = DEFAULT_BINDINGS): void {
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
              { role: 'about', label: `关于 ${app.name}` },
              { type: 'separator' },
              { role: 'services', label: '服务' },
              { type: 'separator' },
              { role: 'hide', label: `隐藏 ${app.name}` },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: `退出 ${app.name}` },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: '文件',
      submenu: [
        // 还没有标签页，所以 ⌘N 直接给新窗口 —— 在当前窗口「新建」会把
        // 用户正在写的东西顶掉。M3 加了标签之后 ⌘N 变成新标签、⌘⇧N 变成新窗口
        { label: '新建窗口', accelerator: 'CmdOrCtrl+N', click: () => actions.newWindow() },
        item('新建标签页', 'file.newTab'),
        item('打开…', 'file.open'),
        item('打开文件夹…', 'file.openFolder'),
        item('关闭文件夹', 'file.closeFolder'),
        item('关闭标签页', 'file.closeTab'),
        item('在新窗口打开…', 'file.openInNewWindow'),
        { type: 'separator' },
        item('保存', 'file.save'),
        item('另存为…', 'file.saveAs'),
        { type: 'separator' },
        item('导出为 HTML…', 'file.exportHtml'),
        item('导出为 PDF…', 'file.exportPdf'),
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴为纯文本' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        item('查找与替换', 'edit.find'),
        { type: 'separator' },
        item('复制为富文本', 'edit.copyRichText'),
      ],
    },
    {
      label: '格式',
      submenu: [
        item('加粗', 'format.bold'),
        item('斜体', 'format.italic'),
        item('行内代码', 'format.code'),
        { type: 'separator' },
        ...([1, 2, 3, 4, 5, 6] as const).map((level) =>
          item(`${level} 级标题`, `format.heading.${level}`),
        ),
        item('普通段落', 'format.heading.0'),
        { type: 'separator' },
        {
          label: '表格',
          submenu: [
            item('插入表格', 'table.insert'),
            { type: 'separator' },
            item('在上方插入行', 'table.rowAbove'),
            item('在下方插入行', 'table.rowBelow'),
            item('删除本行', 'table.deleteRow'),
            { type: 'separator' },
            item('在左侧插入列', 'table.columnBefore'),
            item('在右侧插入列', 'table.columnAfter'),
            item('删除本列', 'table.deleteColumn'),
            { type: 'separator' },
            item('本列左对齐', 'table.align.left'),
            item('本列居中', 'table.align.center'),
            item('本列右对齐', 'table.align.right'),
            item('本列取消对齐', 'table.align.none'),
            { type: 'separator' },
            item('整理表格', 'table.format'),
          ],
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        item('源码模式', 'view.toggleSource'),
        item('文件树', 'view.toggleFiles'),
        item('下一个标签页', 'view.nextTab'),
        item('上一个标签页', 'view.prevTab'),
        item('大纲', 'view.toggleOutline'),
        item('设置…', 'view.settings'),
        item('命令面板', 'view.commandPalette'),
        {
          label: '主题',
          submenu: [
            item('跟随系统', 'view.theme.auto'),
            item('浅色', 'view.theme.light'),
            item('深色', 'view.theme.dark'),
            item('护眼（Sepia）', 'view.theme.sepia'),
            item('高对比', 'view.theme.high-contrast'),
            item('GitHub', 'view.theme.github'),
          ],
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        ...(app.isPackaged
          ? []
          : ([
              { type: 'separator' },
              { role: 'reload', label: '重新加载' },
              { role: 'toggleDevTools', label: '开发者工具' },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        {
          label: '项目主页',
          click: () => void shell.openExternal('https://github.com/zning1994/open-typo-md'),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
