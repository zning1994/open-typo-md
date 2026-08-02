/**
 * 粘贴 / 拖入图片（docs/design/04 §5）。
 *
 * 内核不认识文件系统（原则 P3），所以这里只负责三件事：
 * 从剪贴板 / 拖放里取出图片、决定插到哪儿、把 Markdown 写进文档。
 * 真正落盘的是宿主注入的 `imageSink`。
 *
 * ## 异步插入的位置怎么办
 *
 * 存图是异步的。等它返回时，光标可能已经不在原地了 —— 用户完全可能在这
 * 几毫秒里继续打字。「记下位置，回来再插」是个经典的错误：位置会失效，
 * 图片插到句子中间。
 *
 * 正确做法是让位置**跟着文档变更一起走**。这里用一个 StateField 装待插入
 * 的锚点，每个 transaction 都把它 `mapPos` 一次。文档被整体换掉（切换文件）
 * 时 StateField 重建、锚点消失，那就干脆放弃这次插入 ——
 * 总好过把图片插进另一篇文档。
 */
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { livePreviewConfig } from './config.js'

/** 待插入的锚点。 */
interface Anchor {
  id: number
  pos: number
}

const addAnchor = StateEffect.define<Anchor>()
const dropAnchor = StateEffect.define<number>()

const anchors = StateField.define<readonly Anchor[]>({
  create: () => [],
  update(value, tr) {
    let next = value
    if (tr.docChanged) {
      // assoc = 1：插入点跟着后面的内容走，用户在锚点前面打字时锚点会顺延，
      // 而不是被挤到新内容的后面
      next = next.map((a) => ({ ...a, pos: tr.changes.mapPos(a.pos, 1) }))
    }
    for (const effect of tr.effects) {
      if (effect.is(addAnchor)) next = [...next, effect.value]
      else if (effect.is(dropAnchor)) next = next.filter((a) => a.id !== effect.value)
    }
    return next
  },
})

let nextAnchorId = 1

function anchorPos(state: EditorState, id: number): number | null {
  return state.field(anchors, false)?.find((a) => a.id === id)?.pos ?? null
}

/**
 * 从 alt 文本里挑一个像样的值。
 *
 * 截图粘贴时 Chromium 合成的文件名恒为 `image.png`，拿它当 alt 是纯噪声；
 * 而从 Finder 拖进来的 `架构图.png` 就很有价值。所以只在名字不是那个
 * 合成值时才用它。宁可留空让用户自己填，也不编一个假的描述。
 */
const SYNTHETIC_NAMES = new Set(['image.png', 'image.jpeg', 'image.jpg', 'image'])

function altTextOf(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || SYNTHETIC_NAMES.has(trimmed.toLowerCase())) return ''
  const base = trimmed.replace(/\.[^.]+$/, '')
  // `]` 会提前闭合 alt，`[` 会让解析器犯迷糊 —— 直接去掉，不做转义
  return base.replace(/[[\]]/g, '')
}

/** Markdown 的 URL 里空格和括号必须处理，否则链接在别的渲染器里会断。 */
function encodePath(relative: string): string {
  return relative.replace(/[ ()]/g, (ch) => encodeURIComponent(ch))
}

function imageFilesOf(list: FileList | null | undefined): File[] {
  if (!list) return []
  return Array.from(list).filter((file) => file.type.startsWith('image/'))
}

/**
 * 存图并插入，一张一张来。
 *
 * 串行而不是并发：多张图要按用户拖进来的顺序出现在文档里，
 * 并发完成顺序不可控。图片数量本来也就是个位数。
 */
async function insertImages(view: EditorView, files: File[], at: number): Promise<void> {
  const { imageSink, onImageError } = view.state.facet(livePreviewConfig)
  if (!imageSink) return

  const id = nextAnchorId++
  view.dispatch({ effects: addAnchor.of({ id, pos: at }) })

  try {
    for (const file of files) {
      let relative: string
      try {
        relative = await imageSink({
          mime: file.type,
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })
      } catch (error) {
        // 失败必须说出来。默默什么都不发生，用户会以为自己没粘上，
        // 反复重试 —— 这是最难排查的一类问题（原则 P2）
        onImageError?.(error instanceof Error ? error : new Error(String(error)), file.name)
        continue
      }

      const pos = anchorPos(view.state, id)
      // 锚点没了 = 文档被整体换掉了（切换文件）。放弃，绝不插进别人的文档
      if (pos === null) return

      const markdown = `![${altTextOf(file.name)}](${encodePath(relative)})`
      view.dispatch({
        changes: { from: pos, insert: markdown },
        selection: { anchor: pos + markdown.length },
        scrollIntoView: true,
        userEvent: 'input.mosu.image',
      })
    }
  } finally {
    view.dispatch({ effects: dropAnchor.of(id) })
  }
}

const handlers = EditorView.domEventHandlers({
  paste(event, view) {
    if (!view.state.facet(livePreviewConfig).imageSink) return false
    const files = imageFilesOf(event.clipboardData?.files)
    if (files.length === 0) return false

    // 截图粘贴时剪贴板里往往同时有 text/html，放行会同时插入一份 HTML 源码
    event.preventDefault()
    void insertImages(view, files, view.state.selection.main.from)
    return true
  },

  drop(event, view) {
    if (!view.state.facet(livePreviewConfig).imageSink) return false
    const files = imageFilesOf(event.dataTransfer?.files)
    if (files.length === 0) return false

    // 插到**落点**而不是当前光标处 —— 拖放的语义就是「放在这儿」
    const at = view.posAtCoords({ x: event.clientX, y: event.clientY })
    event.preventDefault()
    void insertImages(view, files, at ?? view.state.selection.main.from)
    return true
  },
})

export function imageInsertion(): Extension {
  return [anchors, handlers]
}
