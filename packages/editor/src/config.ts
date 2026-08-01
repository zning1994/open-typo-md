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

export interface LivePreviewConfig {
  assetResolver: AssetResolver
  /** 关掉图片渲染（大文档降级策略，见 docs/design/02 §9）。 */
  renderImages: boolean
  /**
   * 用户 Ctrl/Cmd + 点击链接时调用。
   *
   * 内核自己不打开任何链接 —— 那需要宿主能力，而且「在哪儿打开」是产品决策
   * （架构 01 §6 要求一律交给系统浏览器，绝不在应用内导航）。
   */
  onOpenLink: ((url: string) => void) | null
}

export const livePreviewConfig = Facet.define<Partial<LivePreviewConfig>, LivePreviewConfig>({
  combine(values) {
    return combineConfig(values, {
      assetResolver: (src: string) => src,
      renderImages: true,
      onOpenLink: null,
    })
  },
})
