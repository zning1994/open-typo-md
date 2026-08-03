/**
 * 上下文菜单的**模板**（issues #17 / #18）。
 *
 * 单独成文件是为了**能测**：`main/menu.ts` 在模块顶层 import 了 electron，
 * node 环境下加载不了；而这里对 electron 只有**类型**依赖（编译后擦除），
 * 于是「菜单里有哪几项、哪些该灰掉、点了给回什么 id」这些真正会写错的东西
 * 可以直接单测。
 *
 * 弹出本身留在 main —— 那是 Electron 的事，也没什么可测的。
 */
import type { MenuItemConstructorOptions } from 'electron'
import type { ContextMenuRequest, ContextMenuResult } from './channels.js'
import type { Translate } from './i18n.js'

/** 自定义项被点中时用来回传结果。 */
export type Pick = (result: ContextMenuResult) => () => void

/** 「复制路径」「在文件夹中显示」这两件事由 main 就地做掉。 */
export type PathAction = (kind: 'copy' | 'reveal', path: string) => void

export function contextMenuTemplate(
  request: ContextMenuRequest,
  t: Translate,
  pick: Pick,
  onPath?: PathAction,
): MenuItemConstructorOptions[] {
  if (request.kind === 'editor') return editorMenu(request, t, pick)
  if (request.kind === 'tab') return tabMenu(request, t, pick, onPath)
  return fileTreeMenu(request, t, pick, onPath)
}

function editorMenu(
  request: Extract<ContextMenuRequest, { kind: 'editor' }>,
  t: Translate,
  pick: Pick,
): MenuItemConstructorOptions[] {
  return [
    // 没选中东西时剪切 / 复制是空操作，灰掉比让人点一下没反应好
    { role: 'cut', label: t('menu.edit.cut'), enabled: request.hasSelection },
    { role: 'copy', label: t('menu.edit.copy'), enabled: request.hasSelection },
    { role: 'paste', label: t('menu.edit.paste') },
    { role: 'pasteAndMatchStyle', label: t('menu.edit.pastePlain') },
    { type: 'separator' },
    { role: 'selectAll', label: t('menu.edit.selectAll') },
    { type: 'separator' },
    {
      label: t('menu.context.findSelection'),
      enabled: request.hasSelection,
      click: pick('editor.findSelection'),
    },
  ]
}

function tabMenu(
  request: Extract<ContextMenuRequest, { kind: 'tab' }>,
  t: Translate,
  pick: Pick,
  onPath?: PathAction,
): MenuItemConstructorOptions[] {
  const path = request.path
  return [
    { label: t('menu.file.closeTab'), click: pick('tab.close') },
    {
      label: t('menu.context.closeOthers'),
      enabled: request.hasOthers,
      click: pick('tab.closeOthers'),
    },
    {
      label: t('menu.context.closeRight'),
      enabled: request.hasRight,
      click: pick('tab.closeRight'),
    },
    { type: 'separator' },
    // 这两项由 main 就地做掉（`onPath`），不回渲染进程 —— 路径已经在请求里了，
    // 绕回去只是多一次往返，还要为此开一个新的剪贴板权限
    {
      label: t('menu.context.copyPath'),
      enabled: path !== null,
      click: () => {
        if (path) onPath?.('copy', path)
      },
    },
    {
      label: t('menu.context.reveal'),
      enabled: path !== null,
      click: () => {
        if (path) onPath?.('reveal', path)
      },
    },
  ]
}

/**
 * 文件树的右键菜单（issue #36）。
 *
 * 两种行分支，但共用尾部的四项 —— 重命名 / 废纸篓 / 复制路径 / 在文件夹中显示
 * 对文件和文件夹是同一件事。
 *
 * **工作区根只保留「新建」那一组**：改名和扔废纸篓在 main 侧会被守卫直接拒
 * （见 path-guard 的 `assertWritableInWorkspace`），菜单里就不该出现 ——
 * 让用户点一下再收到一句报错，是把内部规则当成交互。
 */
function fileTreeMenu(
  request: Extract<ContextMenuRequest, { kind: 'file-tree' }>,
  t: Translate,
  pick: Pick,
  onPath?: PathAction,
): MenuItemConstructorOptions[] {
  const { path, entry, isRoot } = request
  const items: MenuItemConstructorOptions[] = []

  if (entry === 'file') {
    items.push(
      { label: t('menu.context.open'), click: pick('tree.open') },
      { label: t('menu.context.openInNewTab'), click: pick('tree.openInNewTab') },
      { type: 'separator' },
    )
  } else {
    items.push(
      { label: t('menu.context.newFile'), click: pick('tree.newFile') },
      { label: t('menu.context.newFolder'), click: pick('tree.newFolder') },
      { type: 'separator' },
    )
  }

  if (!isRoot) {
    items.push(
      { label: t('menu.context.rename'), click: pick('tree.rename') },
      { label: t('menu.context.trash'), click: pick('tree.trash') },
      { type: 'separator' },
    )
  }

  items.push(
    { label: t('menu.context.copyPath'), click: () => onPath?.('copy', path) },
    { label: t('menu.context.reveal'), click: () => onPath?.('reveal', path) },
  )
  return items
}
