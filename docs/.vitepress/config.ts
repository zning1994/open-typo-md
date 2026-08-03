/**
 * 官网 / 文档站（GitHub Pages）。
 *
 * ## 为什么直接把 `docs/` 当站点根目录
 *
 * 这个仓库的设计文档本来就写在 `docs/design` 与 `docs/adr` 下，而且是**写给人
 * 读的**（取舍、被推翻的结论、踩过的坑），不是自动生成的 API 文档。
 * 与其另起一个 `site/` 再把它们复制或软链过去，不如让站点直接长在原地 ——
 * 少一份会漂移的副本，README 里那些指向 `docs/…` 的链接在 GitHub 上也照常有效。
 *
 * ## 多语言：落地页翻，设计文档暂不翻
 *
 * 这是刻意的取舍，不是没做完。设计文档有九篇加五份 ADR，而且**还在随着开发
 * 变动**（今天就改了四处）—— 翻译一份会漂移的长文档，代价不是翻一次，
 * 是此后每次改动都要翻三次。落地页不一样：它变得慢，而且是决定「要不要继续
 * 看下去」的那一页。
 *
 * 所以 `/en/` 与 `/ja/` 只有落地页，并在页面上**明说**设计文档是中文的。
 * 加一种语言 = 加一个 `LOCALES` 条目 + 一份落地页 + 一份样例文档（截图用）。
 */
import { defineConfig, type DefaultTheme, type LocaleConfig } from 'vitepress'

const REPO = 'mosu'
const GITHUB = `https://github.com/zning1994/${REPO}`

/**
 * 站点域名。**必须跟 `docs/public/CNAME` 里那一行一致。**
 *
 * 用自定义域名时站点挂在域名根下，所以 `base` 是 `/`；如果哪天退回
 * `<user>.github.io/<repo>/`，`base` 要改成 `/mosu/`，否则所有
 * 资源都会 404 —— 而那个失败的样子是「页面出来了但一片空白」，
 * 不容易一眼看出是 base 的问题。
 */
const SITE = 'https://mosu.ohgiantai.com'

const DESIGN = [
  ['00-overview', '00 · 总览'],
  ['01-architecture', '01 · 架构'],
  ['02-editor-core', '02 · 编辑器内核'],
  ['03-markdown-pipeline', '03 · Markdown 管线'],
  ['04-files-and-workspace', '04 · 文件与工作区'],
  ['05-themes-and-plugins', '05 · 主题与插件'],
  ['06-export', '06 · 导出'],
  ['07-quality', '07 · 质量基线'],
  ['08-roadmap', '08 · 路线图'],
  ['09-distribution', '09 · 分发'],
] as const

const ADR = [
  ['0001-desktop-shell', '0001 · 桌面壳选 Electron'],
  ['0002-editor-core', '0002 · 内核选 CodeMirror 6'],
  ['0003-dual-parser', '0003 · 双解析器'],
  ['0004-plugin-isolation', '0004 · 插件隔离'],
  ['0005-windows-and-tabs', '0005 · 窗口与标签'],
] as const

/** 中文站的侧栏 —— 设计文档与 ADR 互为折叠的第二组，两边都能一眼跳过去。 */
const zhSidebar: DefaultTheme.Sidebar = {
  '/design/': [
    { text: '设计文档', items: DESIGN.map(([s, text]) => ({ text, link: `/design/${s}` })) },
    { text: '实测记录', items: [{ text: '两个解析器的已知差异', link: '/known-divergences' }] },
    {
      text: '架构决策记录',
      collapsed: true,
      items: ADR.map(([s, text]) => ({ text, link: `/adr/${s}` })),
    },
  ],
  '/adr/': [
    { text: '架构决策记录', items: ADR.map(([s, text]) => ({ text, link: `/adr/${s}` })) },
    { text: '实测记录', items: [{ text: '两个解析器的已知差异', link: '/known-divergences' }] },
    {
      text: '设计文档',
      collapsed: true,
      items: DESIGN.map(([s, text]) => ({ text, link: `/design/${s}` })),
    },
  ],
  // 这一页不在 design/ 或 adr/ 下，得单独给一份侧栏 —— 否则从设计文档点过来
  // 之后侧栏整个消失，读者会以为自己离开了文档区
  '/known-divergences': [
    { text: '实测记录', items: [{ text: '两个解析器的已知差异', link: '/known-divergences' }] },
    {
      text: '设计文档',
      collapsed: true,
      items: DESIGN.map(([s, text]) => ({ text, link: `/design/${s}` })),
    },
    {
      text: '架构决策记录',
      collapsed: true,
      items: ADR.map(([s, text]) => ({ text, link: `/adr/${s}` })),
    },
  ],
}

/**
 * 各语言共用的那部分主题配置。
 *
 * 抽出来是因为 `editLink.pattern` 之类的东西每加一种语言就要重复一遍，
 * 而重复的配置迟早会漂移 —— 典型症状是「英文站的编辑链接指向了半年前的路径」。
 */
function themeFor(labels: {
  edit: string
  outline: string
  prev: string
  next: string
  updated: string
  theme: string
  toTop: string
  menu: string
  footer: string
}): DefaultTheme.Config {
  return {
    socialLinks: [{ icon: 'github', link: GITHUB }],
    editLink: { pattern: `${GITHUB}/edit/main/docs/:path`, text: labels.edit },
    outline: { level: [2, 3], label: labels.outline },
    docFooter: { prev: labels.prev, next: labels.next },
    lastUpdatedText: labels.updated,
    darkModeSwitchLabel: labels.theme,
    returnToTopLabel: labels.toTop,
    sidebarMenuLabel: labels.menu,
    footer: {
      message: labels.footer,
      copyright: 'Copyright © 2026 Mosu Contributors',
    },
  }
}

const LOCALES: LocaleConfig<DefaultTheme.Config> = {
  root: {
    label: '简体中文',
    lang: 'zh-CN',
    description: '开源的 Markdown 所见即所得编辑器 —— 无分屏、无预览窗格，写下的就是看到的。',
    themeConfig: {
      ...themeFor({
        edit: '在 GitHub 上编辑此页',
        outline: '本页目录',
        prev: '上一篇',
        next: '下一篇',
        updated: '最后更新',
        theme: '主题',
        toTop: '回到顶部',
        menu: '目录',
        footer: 'MIT 许可发布。与 Typora 无关联，是一个独立实现。',
      }),
      nav: [
        { text: '设计文档', link: '/design/00-overview' },
        { text: '架构决策', link: '/adr/0001-desktop-shell' },
        { text: '路线图', link: '/design/08-roadmap' },
        { text: '下载', link: `${GITHUB}/releases/latest` },
      ],
      sidebar: zhSidebar,
    },
  },

  en: {
    label: 'English',
    lang: 'en-US',
    link: '/en/',
    description:
      'An open-source WYSIWYG Markdown editor — no split pane, no preview pane. What you type is what you see.',
    themeConfig: {
      ...themeFor({
        edit: 'Edit this page on GitHub',
        outline: 'On this page',
        prev: 'Previous',
        next: 'Next',
        updated: 'Last updated',
        theme: 'Appearance',
        toTop: 'Back to top',
        menu: 'Menu',
        footer: 'Released under the MIT License. Not affiliated with Typora.',
      }),
      nav: [
        { text: 'Design docs (Chinese)', link: '/design/00-overview' },
        { text: 'Roadmap (Chinese)', link: '/design/08-roadmap' },
        { text: 'Download', link: `${GITHUB}/releases/latest` },
      ],
    },
  },

  ja: {
    label: '日本語',
    lang: 'ja-JP',
    link: '/ja/',
    description:
      'オープンソースの WYSIWYG Markdown エディタ。分割ビューもプレビューペインもなく、書いたものがそのまま見えます。',
    themeConfig: {
      ...themeFor({
        edit: 'GitHub でこのページを編集',
        outline: 'このページの内容',
        prev: '前へ',
        next: '次へ',
        updated: '最終更新',
        theme: '外観',
        toTop: 'トップへ戻る',
        menu: 'メニュー',
        footer: 'MIT ライセンスで公開。Typora とは無関係です。',
      }),
      nav: [
        { text: '設計ドキュメント（中国語）', link: '/design/00-overview' },
        { text: 'ロードマップ（中国語）', link: '/design/08-roadmap' },
        { text: 'ダウンロード', link: `${GITHUB}/releases/latest` },
      ],
    },
  },
}

export default defineConfig({
  title: 'Mosu',
  base: '/',
  sitemap: { hostname: SITE },
  lastUpdated: true,
  cleanUrls: true,
  locales: LOCALES,

  /**
   * 把 Vue 的插值分隔符换掉，让 `{{ … }}` 在文档里就是字面量。
   *
   * **踩过一次**：`docs/design/00-overview.md` 里有一句
   * `` `${{ github.repository }}` ``（讲 CI 里不写死仓库 slug）。围栏代码块
   * VitePress 会自动包 `v-pre`，**行内代码不会** —— 于是 Vue 把它当插值编译，
   * SSR 时求值 `github.repository` 抛 `Cannot read properties of undefined`。
   *
   * 而 VitePress **吞掉这个异常**：构建照常退出 0，只是那一页的正文是空的。
   * 于是「建站绿了」和「页面能看」变成了两件事，线上空了一页没人知道。
   * 正文非空的检查见 `scripts/check-docs-build.mjs`，它挂在 `docs:build` 里面
   * 而不是某个 workflow 的步骤上 —— 挂在步骤上就总有一条路径会忘了它。
   *
   * 为什么换分隔符而不是在那一句上包 `<span v-pre>`：这些设计文档**本身也是
   * 产品内容**（用 Mosu 打开来读的就是它们），往里塞站点框架的语法是把两件事
   * 搅在一起。而且这个仓库的文档天生会反复出现 `${{ }}`（讲的就是 CI），
   * 逐处去包是一张永远追不完的清单。
   *
   * 代价：文档里从此**无法**使用 Vue 插值。当前一处都没用，将来真要用就写
   * 新的分隔符 —— 那反而是件好事，因为它是显式的。
   */
  vue: {
    template: {
      compilerOptions: { delimiters: ['{%', '%}'] },
    },
  },

  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/favicon.png' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#26262a' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Mosu' }],
    ['meta', { property: 'og:url', content: SITE }],
    ['meta', { property: 'og:image', content: `${SITE}/shots/en/hero-light.png` }],
  ],

  themeConfig: {
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
              modal: {
                displayDetails: '展开',
                resetButtonTitle: '清空',
                noResultsText: '没有找到',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
          ja: {
            translations: {
              button: { buttonText: '検索', buttonAriaLabel: '検索' },
              modal: {
                displayDetails: '詳細を表示',
                resetButtonTitle: 'クリア',
                noResultsText: '見つかりませんでした',
                footer: { selectText: '選択', navigateText: '移動', closeText: '閉じる' },
              },
            },
          },
        },
      },
    },
  },
})
