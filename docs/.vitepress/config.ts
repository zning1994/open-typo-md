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
 * 代价是 `docs/` 里多出 `index.md` 与 `.vitepress/`。可以接受。
 *
 * ## 站点定位
 *
 * 首页面向「要不要用它」，其余全部是**设计文档**而不是用户手册。
 * 这是刻意的：这个项目现在最值得看的东西就是那些取舍，
 * 而功能清单 README 里已经有了。等真有了用户手册再单开一档。
 */
import { defineConfig } from 'vitepress'

/** 仓库名。GitHub Pages 部署在 `<user>.github.io/<repo>/` 下，base 必须带上它。 */
const REPO = 'open-typo-md'

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
] as const

const ADR = [
  ['0001-desktop-shell', '0001 · 桌面壳选 Electron'],
  ['0002-editor-core', '0002 · 内核选 CodeMirror 6'],
  ['0003-dual-parser', '0003 · 双解析器'],
  ['0004-plugin-isolation', '0004 · 插件隔离'],
  ['0005-windows-and-tabs', '0005 · 窗口与标签'],
] as const

export default defineConfig({
  lang: 'zh-CN',
  title: 'Brainforge Typo',
  description: '开源的 Markdown 所见即所得编辑器 —— 无分屏、无预览窗格，写下的就是看到的。',
  base: `/${REPO}/`,
  lastUpdated: true,
  cleanUrls: true,

  head: [
    ['meta', { name: 'theme-color', content: '#0969da' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Brainforge Typo' }],
    [
      'meta',
      {
        property: 'og:description',
        content: '开源的 Markdown 所见即所得编辑器。源码优先，往返零损耗。',
      },
    ],
  ],

  themeConfig: {
    nav: [
      { text: '设计文档', link: '/design/00-overview' },
      { text: '架构决策', link: '/adr/0001-desktop-shell' },
      { text: '路线图', link: '/design/08-roadmap' },
      {
        text: '下载',
        link: `https://github.com/zning1994/${REPO}/releases`,
      },
    ],

    sidebar: {
      '/design/': [
        {
          text: '设计文档',
          items: DESIGN.map(([slug, text]) => ({ text, link: `/design/${slug}` })),
        },
        {
          text: '架构决策记录',
          collapsed: true,
          items: ADR.map(([slug, text]) => ({ text, link: `/adr/${slug}` })),
        },
      ],
      '/adr/': [
        {
          text: '架构决策记录',
          items: ADR.map(([slug, text]) => ({ text, link: `/adr/${slug}` })),
        },
        {
          text: '设计文档',
          collapsed: true,
          items: DESIGN.map(([slug, text]) => ({ text, link: `/design/${slug}` })),
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: `https://github.com/zning1994/${REPO}` }],

    editLink: {
      pattern: `https://github.com/zning1994/${REPO}/edit/main/docs/:path`,
      text: '在 GitHub 上编辑此页',
    },

    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdatedText: '最后更新',
    darkModeSwitchLabel: '主题',
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',

    footer: {
      message: 'MIT 许可发布。与 Typora 无关联，是一个独立实现。',
      copyright: 'Copyright © 2026 Brainforge Typo Contributors',
    },

    search: { provider: 'local' },
  },
})
