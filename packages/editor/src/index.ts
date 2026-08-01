export { TypoEditor } from './editor.js'
export type { EditorStats, EditorStatus, TypoEditorOptions } from './editor.js'
export { livePreviewConfig, type AssetResolver, type LivePreviewConfig } from './config.js'
export {
  livePreview,
  computeDecorations,
  activeState,
  revealsLine,
  revealsRange,
  type BuildResult,
  type ActiveState,
} from './live-preview/index.js'
export { BulletWidget, ImageWidget, RuleWidget } from './live-preview/widgets.js'
export {
  continueMarkup,
  currentHeadingLevel,
  setHeading,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
  toggleWrap,
  typoCommands,
  typoKeymap,
} from './commands.js'
export { CODE_LINE_CLASS, codeBlockScrollSync } from './code-block.js'
export { linkInteraction, linkTargetAt } from './links.js'
export { baseTheme, markdownHighlight, typoTheme } from './theme.js'
