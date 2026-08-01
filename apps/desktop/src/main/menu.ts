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

export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const send = (command: MenuCommand) => () => {
    getWindow()?.webContents.send(EVENTS.menuCommand, command)
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
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: send('file.new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: send('file.open') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: send('file.save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: send('file.saveAs') },
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
