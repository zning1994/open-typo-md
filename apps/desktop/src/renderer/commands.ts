/**
 * 命令注册表。
 *
 * 一张表同时喂两个消费者：原生菜单（main 侧发来 `MenuCommand`）和命令面板。
 * 两处各写一份的结果一定是「菜单里有、面板里没有」——
 * 而这种不一致用户一眼就能看见。
 *
 * 这张表也是「可配置快捷键」的前提：命令有稳定 id 之后，按键绑定才有东西可绑。
 * **绑定本身不在这里** —— 它在 `shared/keys.ts`，由 main 与渲染进程共用
 * （见那个文件开头「为什么必须先有这个文件」）。
 */
import type { MenuCommand } from '../shared/channels.js'
import type { MessageKey } from '../shared/i18n.js'
import { t } from './i18n.js'

export interface Command {
  id: string
  title: string
  /** 搜索时一并匹配的别名，方便用拼音首字母或英文名找到它。 */
  keywords?: string
  /** 当前的按键绑定，仅用于在面板里显示。 */
  binding?: string
  run: () => void
}

export { formatBinding } from '../shared/keys.js'

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

/**
 * 菜单命令 → 面板里显示的标题。快捷键查 `shared/keys.ts`，不在这儿重复一份。
 *
 * 是**函数**而不是常量表：文案要跟着界面语言走，而语言在模块求值时还没从磁盘
 * 读回来。写成常量的话切语言只有面板变、这张表还留着启动时那一份。
 *
 * 跟 `menu.*` 分成两套的理由见 `shared/messages/zh-CN.ts` 文件头：菜单里
 * 「整理表格」挂在「表格」下面，上下文自明；命令面板是平铺的，同一条要写成
 * 「表格：整理」才认得出。
 */
export function menuCommandTitle(command: MenuCommand): string {
  const heading = /^format\.heading\.([1-6])$/.exec(command)
  if (heading) return t('command.format.heading', { level: Number(heading[1]) })

  const theme = /^view\.theme\.(.+)$/.exec(command)
  if (theme) {
    return t('command.view.theme', { name: t(`theme.${theme[1]}` as MessageKey) })
  }

  return t(COMMAND_KEYS[command])
}

/** 命令 id → 文案键。标题里带参数的（标题级别、主题名）在上面单独处理。 */
const COMMAND_KEYS: Record<MenuCommand, MessageKey> = {
  'file.open': 'command.file.open',
  'file.openInNewWindow': 'command.file.openInNewWindow',
  'file.save': 'command.file.save',
  'file.saveAll': 'command.file.saveAll',
  'file.saveAs': 'command.file.saveAs',
  'file.newTab': 'command.file.newTab',
  'file.closeTab': 'command.file.closeTab',
  'file.openFolder': 'command.file.openFolder',
  'file.closeFolder': 'command.file.closeFolder',
  'file.exportHtml': 'command.file.exportHtml',
  'file.exportPdf': 'command.file.exportPdf',
  'edit.copyRichText': 'command.edit.copyRichText',
  'edit.find': 'command.edit.find',
  'edit.findInFiles': 'command.edit.findInFiles',
  'view.toggleFiles': 'command.view.toggleFiles',
  'view.nextTab': 'command.view.nextTab',
  'view.prevTab': 'command.view.prevTab',
  'view.toggleSource': 'command.view.toggleSource',
  'view.toggleFocus': 'command.view.toggleFocus',
  'view.toggleTypewriter': 'command.view.toggleTypewriter',
  'view.toggleOutline': 'command.view.toggleOutline',
  'view.commandPalette': 'command.view.commandPalette',
  'view.quickOpen': 'command.view.quickOpen',
  'view.settings': 'command.view.settings',
  // 这六条走 menuCommandTitle 里的分支，键在这里只是为了让类型完整
  'view.theme.auto': 'theme.auto',
  'view.theme.light': 'theme.light',
  'view.theme.dark': 'theme.dark',
  'view.theme.sepia': 'theme.sepia',
  'view.theme.high-contrast': 'theme.high-contrast',
  'view.theme.github': 'theme.github',
  'format.bold': 'command.format.bold',
  'format.italic': 'command.format.italic',
  'format.code': 'command.format.code',
  'format.heading.0': 'command.format.paragraph',
  'format.heading.1': 'command.format.heading',
  'format.heading.2': 'command.format.heading',
  'format.heading.3': 'command.format.heading',
  'format.heading.4': 'command.format.heading',
  'format.heading.5': 'command.format.heading',
  'format.heading.6': 'command.format.heading',
  'table.insert': 'command.table.insert',
  'table.rowAbove': 'command.table.rowAbove',
  'table.rowBelow': 'command.table.rowBelow',
  'table.deleteRow': 'command.table.deleteRow',
  'table.columnBefore': 'command.table.columnBefore',
  'table.columnAfter': 'command.table.columnAfter',
  'table.deleteColumn': 'command.table.deleteColumn',
  'table.align.left': 'command.table.alignLeft',
  'table.align.center': 'command.table.alignCenter',
  'table.align.right': 'command.table.alignRight',
  'table.align.none': 'command.table.alignNone',
  'table.format': 'command.table.format',
}
