/**
 * 实时预览扩展的装配。
 *
 * build.ts 决定「画什么」，这个文件决定「什么时候画」—— 其中最要命的一条是
 * 输入法组合期间必须停手（docs/design/02 §4.2）。
 */
import type { Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { livePreviewConfig } from '../config.js'
import { computeDecorations } from './build.js'

export { computeDecorations, type BuildResult } from './build.js'
export { activeState, revealsLine, revealsRange, type ActiveState } from './active.js'

class LivePreviewPlugin {
  decorations: DecorationSet
  atomic: DecorationSet
  private composing = false

  constructor(view: EditorView) {
    const result = computeDecorations(view.state, view.visibleRanges)
    this.decorations = result.decorations
    this.atomic = result.atomic
  }

  update(update: ViewUpdate): void {
    const composingNow = update.view.composing

    if (composingNow) {
      // 输入法组合中。
      //
      // 重建装饰会替换 DOM，而浏览器此刻正把组合中的文字挂在那些节点上 ——
      // 结果就是丢字、光标乱跳、候选框闪退。所以这里只做位置映射，
      // 等组合结束再算。这是目标 G1 的硬性门槛，不是可以「以后优化」的东西。
      this.composing = true
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes)
        this.atomic = this.atomic.map(update.changes)
      }
      return
    }

    const justFinishedComposing = this.composing
    this.composing = false

    const needsRebuild =
      justFinishedComposing ||
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.startState.facet(livePreviewConfig) !== update.state.facet(livePreviewConfig) ||
      // 大文档的语法树是分批解析出来的，解析推进时也要重画
      syntaxTree(update.startState) !== syntaxTree(update.state)

    if (!needsRebuild) return

    const result = computeDecorations(update.view.state, update.view.visibleRanges)
    this.decorations = result.decorations
    this.atomic = result.atomic
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (plugin) => plugin.decorations,
})

/**
 * 实时预览扩展。
 *
 * 关掉它就是源码模式 —— 见 ../modes.ts，那里用 Compartment 做热切换。
 */
export function livePreview(): Extension {
  return [
    livePreviewPlugin,
    // 让方向键一次跨过被隐藏的标记，而不是「按一次没反应、按两次跳两格」
    EditorView.atomicRanges.of(
      (view) => view.plugin(livePreviewPlugin)?.atomic ?? Decoration.none,
    ),
  ]
}
