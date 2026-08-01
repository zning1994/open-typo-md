/**
 * 命令注册表。
 *
 * 一张表同时喂两个消费者：原生菜单（main 侧发来 `MenuCommand`）和命令面板。
 * 两处各写一份的结果一定是「菜单里有、面板里没有」——
 * 而这种不一致用户一眼就能看见。
 *
 * 这张表也是「可配置快捷键」的前提：命令有稳定 id 之后，按键绑定才有东西可绑。
 * 绑定的**编辑界面**属于设置界面，已随 M4.5 搁置，所以现在只有默认绑定。
 */
import type { MenuCommand } from '../shared/channels.js'

export interface Command {
  id: string
  title: string
  /** 搜索时一并匹配的别名，方便用拼音首字母或英文名找到它。 */
  keywords?: string
  /** 当前的按键绑定，仅用于在面板里显示。 */
  binding?: string
  run: () => void
}

/** 把平台无关的 `Mod` 写法渲染成当前平台的样子。 */
export function formatBinding(binding: string, mac: boolean): string {
  return binding
    .replace(/Mod/g, mac ? '⌘' : 'Ctrl')
    .replace(/Shift/g, mac ? '⇧' : 'Shift')
    .replace(/Alt/g, mac ? '⌥' : 'Alt')
    .replace(/\+/g, mac ? '' : '+')
}

/**
 * 模糊匹配：查询里的字符按顺序出现在候选里即可命中。
 *
 * 刻意不引入打分库。命令总数是几十条量级，用户输入两三个字符就已经收敛到
 * 个位数了，排序收益极小，而多一个依赖是实打实的成本。
 *
 * 返回 null 表示不匹配；否则返回**命中位置**，供高亮用。
 */
export function fuzzyMatch(query: string, target: string): number[] | null {
  if (!query) return []
  const needle = query.toLowerCase()
  const hay = target.toLowerCase()

  const hits: number[] = []
  let at = 0
  for (const ch of needle) {
    if (ch === ' ') continue // 空格只当分隔，不参与匹配
    const found = hay.indexOf(ch, at)
    if (found < 0) return null
    hits.push(found)
    at = found + 1
  }
  return hits
}

/** 按「连续命中越多越靠前」排序 —— 前缀匹配自然会排到最上面。 */
export function scoreOf(hits: number[]): number {
  if (hits.length === 0) return 0
  let score = -(hits[0] as number) // 越靠前越好
  for (let i = 1; i < hits.length; i++) {
    if ((hits[i] as number) === (hits[i - 1] as number) + 1) score += 2
  }
  return score
}

export interface CommandSearchResult {
  command: Command
  hits: number[]
}

export function searchCommands(
  commands: readonly Command[],
  query: string,
): CommandSearchResult[] {
  const results: Array<CommandSearchResult & { score: number }> = []
  for (const command of commands) {
    const onTitle = fuzzyMatch(query, command.title)
    if (onTitle) {
      results.push({ command, hits: onTitle, score: scoreOf(onTitle) + 10 })
      continue
    }
    // 标题没命中再试别名。别名命中不高亮标题，所以 hits 给空
    if (command.keywords && fuzzyMatch(query, command.keywords)) {
      results.push({ command, hits: [], score: 0 })
    }
  }
  return results
    .sort((a, b) => b.score - a.score)
    .map(({ command, hits }) => ({ command, hits }))
}

/** 菜单命令 → 面板里显示的标题与快捷键。跟 main/menu.ts 里的菜单项一一对应。 */
export const MENU_COMMAND_INFO: Record<MenuCommand, { title: string; binding?: string }> = {
  'file.open': { title: '打开…', binding: 'Mod+O' },
  'file.openInNewWindow': { title: '在新窗口打开…', binding: 'Mod+Shift+O' },
  'file.save': { title: '保存', binding: 'Mod+S' },
  'file.saveAs': { title: '另存为…', binding: 'Mod+Shift+S' },
  'view.toggleSource': { title: '切换源码模式', binding: 'Mod+/' },
  'view.toggleOutline': { title: '显示 / 隐藏大纲', binding: 'Mod+Shift+E' },
  'view.commandPalette': { title: '命令面板', binding: 'Mod+Shift+P' },
  'view.theme.auto': { title: '主题：跟随系统' },
  'view.theme.light': { title: '主题：浅色' },
  'view.theme.dark': { title: '主题：深色' },
  'view.theme.sepia': { title: '主题：护眼（Sepia）' },
  'view.theme.high-contrast': { title: '主题：高对比' },
  'view.theme.github': { title: '主题：GitHub' },
  'edit.find': { title: '查找与替换', binding: 'Mod+F' },
  'format.bold': { title: '加粗', binding: 'Mod+B' },
  'format.italic': { title: '斜体', binding: 'Mod+I' },
  'format.code': { title: '行内代码', binding: 'Mod+E' },
  'format.heading.0': { title: '普通段落', binding: 'Mod+0' },
  'format.heading.1': { title: '一级标题', binding: 'Mod+1' },
  'format.heading.2': { title: '二级标题', binding: 'Mod+2' },
  'format.heading.3': { title: '三级标题', binding: 'Mod+3' },
  'format.heading.4': { title: '四级标题', binding: 'Mod+4' },
  'format.heading.5': { title: '五级标题', binding: 'Mod+5' },
  'format.heading.6': { title: '六级标题', binding: 'Mod+6' },
}
