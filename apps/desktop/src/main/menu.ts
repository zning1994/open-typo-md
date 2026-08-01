/**
 * 原生菜单。
 *
 * 菜单项不直接执行动作，只往渲染进程发一个命令名 —— 具体做什么由渲染进程
 * 决定。这样菜单、快捷键、命令面板（M3）走的是同一条路径，不会出现
 * 「菜单能用但快捷键行为不一样」这种经典分裂。
 */
import { Menu, app, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { EVENTS, type MenuCommand } from '../shared/channels.js'

const isMac = process.platform === 'darwin'

export interface MenuActions {
  /** 新建一个空窗口。窗口级动作由 main 直接执行，不必绕渲染进程一圈。 */
  newWindow: () => void
  /** 当前聚焦的窗口 —— 多窗口下菜单命令必须投递给它，不能有全局单例。 */
  focusedWindow: () => BrowserWindow | null
}

export function buildMenu(actions: MenuActions): void {
  const send = (command: MenuCommand) => () => {
    actions.focusedWindow()?.webContents.send(EVENTS.menuCommand, command)
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
        { label: '新建标签页', accelerator: 'CmdOrCtrl+T', click: send('file.newTab') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: send('file.open') },
        {
          label: '打开文件夹…',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: send('file.openFolder'),
        },
        { label: '关闭文件夹', click: send('file.closeFolder') },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: send('file.closeTab') },
        {
          label: '在新窗口打开…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: send('file.openInNewWindow'),
        },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: send('file.save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: send('file.saveAs') },
        { type: 'separator' },
        { label: '导出为 HTML…', click: send('file.exportHtml') },
        { label: '导出为 PDF…', click: send('file.exportPdf') },
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
        { label: '查找与替换', accelerator: 'CmdOrCtrl+F', click: send('edit.find') },
        { type: 'separator' },
        { label: '复制为富文本', click: send('edit.copyRichText') },
      ],
    },
    {
      label: '格式',
      submenu: [
        { label: '加粗', accelerator: 'CmdOrCtrl+B', click: send('format.bold') },
        { label: '斜体', accelerator: 'CmdOrCtrl+I', click: send('format.italic') },
        { label: '行内代码', accelerator: 'CmdOrCtrl+E', click: send('format.code') },
        { type: 'separator' },
        ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({
          label: `${level} 级标题`,
          accelerator: `CmdOrCtrl+${level}`,
          click: send(`format.heading.${level}`),
        })),
        { label: '普通段落', accelerator: 'CmdOrCtrl+0', click: send('format.heading.0') },
        { type: 'separator' },
        {
          label: '表格',
          submenu: [
            { label: '插入表格', click: send('table.insert') },
            { type: 'separator' },
            { label: '在上方插入行', click: send('table.rowAbove') },
            { label: '在下方插入行', click: send('table.rowBelow') },
            { label: '删除本行', click: send('table.deleteRow') },
            { type: 'separator' },
            { label: '在左侧插入列', click: send('table.columnBefore') },
            { label: '在右侧插入列', click: send('table.columnAfter') },
            { label: '删除本列', click: send('table.deleteColumn') },
            { type: 'separator' },
            { label: '本列左对齐', click: send('table.align.left') },
            { label: '本列居中', click: send('table.align.center') },
            { label: '本列右对齐', click: send('table.align.right') },
            { label: '本列取消对齐', click: send('table.align.none') },
            { type: 'separator' },
            { label: '整理表格', click: send('table.format') },
          ],
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '源码模式',
          accelerator: 'CmdOrCtrl+/',
          click: send('view.toggleSource'),
        },
        {
          label: '文件树',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: send('view.toggleFiles'),
        },
        {
          label: '下一个标签页',
          accelerator: 'Control+Tab',
          click: send('view.nextTab'),
        },
        {
          label: '上一个标签页',
          accelerator: 'Control+Shift+Tab',
          click: send('view.prevTab'),
        },
        {
          label: '大纲',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: send('view.toggleOutline'),
        },
        {
          label: '设置…',
          accelerator: 'CmdOrCtrl+,',
          click: send('view.settings'),
        },
        {
          label: '命令面板',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: send('view.commandPalette'),
        },
        {
          label: '主题',
          submenu: [
            { label: '跟随系统', click: send('view.theme.auto') },
            { label: '浅色', click: send('view.theme.light') },
            { label: '深色', click: send('view.theme.dark') },
            { label: '护眼（Sepia）', click: send('view.theme.sepia') },
            { label: '高对比', click: send('view.theme.high-contrast') },
            { label: 'GitHub', click: send('view.theme.github') },
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
