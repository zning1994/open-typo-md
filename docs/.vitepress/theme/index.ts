/**
 * 站点主题：默认主题 + 一份共用样式。
 *
 * 存在的唯一理由是让三份落地页共用截图那几条 CSS（见 custom.css 开头）。
 * 除此之外不改默认主题 —— 站点的价值在内容上，不在外观上。
 */
import DefaultTheme from 'vitepress/theme'
import './custom.css'

export default DefaultTheme
