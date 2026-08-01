/**
 * 粘贴富文本（docs/design/03 §8）。
 *
 * 从网页、Word、Google 文档里复制过来的内容，剪贴板里同时躺着 `text/plain`
 * 和 `text/html`。默认行为只取前者 —— 格式全丢。这里在两者都在的时候，
 * 把 HTML 转成 Markdown 再插进去。
 *
 * ## 三条让路规则
 *
 * 这个处理器很容易变成「什么粘贴都归我管」，那会踩坏另外三件已经对了的事：
 *
 * 1. **剪贴板里有图片文件** → 交给 `images.ts`。截图粘贴时剪贴板里往往
 *    同时有 `text/html`（一个 `<img>`），抢过来会插一段没用的 HTML 源码，
 *    而不是把图存下来。
 * 2. **HTML 里没有 Markdown 表达得了的结构** → 交给默认的纯文本粘贴。
 *    判断在 `@typo/import` 里（从代码编辑器复制的代码就属于这一类）。
 * 3. **只有 `text/plain`** → 什么都不做。菜单里的「粘贴为纯文本」正是靠这条
 *    生效的 —— 宿主那一侧只放纯文本进剪贴板事件，这里自然就不插手了。
 *
 * ## 为什么不做成异步
 *
 * 见 `@typo/import` 的说明：同步转换让「插入位置在等待期间失效」这一整类
 * 问题根本不存在。
 */
import { EditorView } from '@codemirror/view'
import { htmlToMarkdown } from '@typo/import'
import type { Extension } from '@codemirror/state'

function hasImageFile(data: DataTransfer): boolean {
  return Array.from(data.files ?? []).some((file) => file.type.startsWith('image/'))
}

const handlers = EditorView.domEventHandlers({
  paste(event, view) {
    if (view.state.readOnly) return false

    const data = event.clipboardData
    if (!data || hasImageFile(data)) return false

    const html = data.getData('text/html')
    if (!html) return false

    let markdown: string | null
    try {
      markdown = htmlToMarkdown(html)
    } catch {
      // 转换炸了就退回纯文本 —— 内容还在，只是没了格式。
      // 这里绝不能把粘贴整个吃掉：用户会以为自己没按下 Ctrl+V（原则 P2）
      return false
    }
    if (markdown === null) return false

    event.preventDefault()
    view.dispatch({
      ...view.state.replaceSelection(markdown),
      scrollIntoView: true,
      userEvent: 'input.paste',
    })
    return true
  },
})

export function richTextPaste(): Extension {
  return handlers
}
