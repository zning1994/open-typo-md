/**
 * 编辑器内核的配置面。
 *
 * 内核不认识 Electron（原则 P3），凡是需要宿主参与的能力都从这里注入。
 */
import { Facet, combineConfig } from '@codemirror/state'

/**
 * 把 Markdown 里的图片路径解析成渲染层可加载的 URL。
 *
 * 必须是**同步**的：装饰构建跑在按键路径上，不能等 Promise。
 * Electron 侧的实现就是把相对路径拼成 `typo-asset://…`（纯字符串运算），
 * 真正的路径合法性校验发生在 main 进程的协议处理器里（docs/design/01 §6）。
 *
 * 默认实现原样返回 —— 测试环境和纯文本场景下不做任何解析。
 */
export type AssetResolver = (src: string) => string

/** 一张待落盘的图片，来自剪贴板或拖放。 */
export interface PastedImage {
  mime: string
  /** 来源文件名，可能是宿主合成的（截图粘贴恒为 `image.png`）。 */
  name: string
  bytes: Uint8Array
}

/**
 * 把图片存到宿主那边，返回**可以直接写进 Markdown 的路径**
 * （通常是相对当前文件的 `assets/xxx.png`）。
 *
 * 失败必须抛错，不能返回空字符串糊过去 —— 调用方要把失败原因告诉用户。
 */
export type ImageSink = (image: PastedImage) => Promise<string>

export interface LivePreviewConfig {
  assetResolver: AssetResolver
  /** 关掉图片渲染（大文档降级策略，见 docs/design/02 §9）。 */
  renderImages: boolean
  /**
   * 渲染文档里的行内 HTML（`<b>` `<sup>` `<kbd>` 那几个）。
   *
   * 默认开。给得出一个开关是因为这是唯一一条安全相关的路径 —— 尽管实现上
   * 一个字节的 HTML 都不进 DOM（见 live-preview/inline-html.ts），
   * 「我要看见我文件里到底写了什么」本身也是个正当诉求。
   */
  renderInlineHtml: boolean
  /**
   * 用户 Ctrl/Cmd + 点击链接时调用。
   *
   * 内核自己不打开任何链接 —— 那需要宿主能力，而且「在哪儿打开」是产品决策
   * （架构 01 §6 要求一律交给系统浏览器，绝不在应用内导航）。
   */
  onOpenLink: ((url: string) => void) | null
  /**
   * 粘贴 / 拖入图片时调用。为 null 时整个功能关闭，粘贴走默认行为。
   *
   * 未保存的新文档没有落脚目录，宿主应当在这里抛错并提示先保存 ——
   * 内核不替宿主决定「存哪儿」。
   */
  imageSink: ImageSink | null
  /** 存图失败时调用。宿主负责怎么告诉用户（对话框 / 状态栏）。 */
  onImageError: ((error: Error, name: string) => void) | null
}

export const livePreviewConfig = Facet.define<Partial<LivePreviewConfig>, LivePreviewConfig>({
  combine(values) {
    return combineConfig(values, {
      assetResolver: (src: string) => src,
      renderImages: true,
      renderInlineHtml: true,
      onOpenLink: null,
      imageSink: null,
      onImageError: null,
    })
  },
})
