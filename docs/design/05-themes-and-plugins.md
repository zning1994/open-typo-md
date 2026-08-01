# 05 · 主题与插件

## 一、主题

### 1. 为什么主题必须是纯 CSS

Typora 生态最有价值的资产就是社区主题。要复制这个效果，门槛必须低到
「会写 CSS 就能做主题」，且**主题不能因为应用升级而炸**。

因此：

- 主题 = 一个 CSS 文件（可带资源目录），不是 JS。
- 编辑器暴露一份**稳定的类名与 CSS 变量契约**，进 semver 管理。
- 契约变更走废弃期：旧类名保留至少两个 minor 版本，控制台给出废弃警告。

### 2. 变量契约

```css
:root {
  /* 排版 */
  --typo-font-body: -apple-system, "Segoe UI", "PingFang SC", sans-serif;
  --typo-font-mono: "JetBrains Mono", Menlo, Consolas, monospace;
  --typo-font-size: 16px;
  --typo-line-height: 1.7;
  --typo-content-width: 40em;

  /* 颜色（语义化，不是"blue-500"这种） */
  --typo-bg: #fff;
  --typo-fg: #24292f;
  --typo-fg-muted: #6e7781;
  --typo-accent: #0969da;
  --typo-border: #d0d7de;
  --typo-code-bg: #f6f8fa;
  --typo-selection: #b4d5fe;

  /* 编辑器专属 */
  --typo-marker-fg: #b0b6bd;      /* 显形的 Markdown 标记 */
  --typo-cursor: var(--typo-fg);
  --typo-focus-dim: 0.35;          /* 专注模式下非当前段的不透明度 */
}
```

深色模式：主题在 `@media (prefers-color-scheme: dark)` 与 `[data-theme="dark"]`
两处都提供覆盖（后者用于用户手动切换）。

### 3. 类名契约

内容区根节点 `.typo-content`，所有块级元素带 `.typo-<type>`：

```
.typo-content
├── .typo-heading.typo-h1 … .typo-h6
├── .typo-paragraph
├── .typo-list.typo-list--ordered / --bullet / --task
├── .typo-blockquote
├── .typo-code-block[data-lang="ts"]
├── .typo-table
├── .typo-math.typo-math--block / --inline
├── .typo-image
└── .typo-hr
```

状态类：`.typo-active`（光标所在块）、`.typo-source-visible`（标记显形中）、
`.typo-widget-editing`。

**打印样式是契约的一部分**：主题必须在 `@media print` 下可用，导出 PDF 直接复用（见 06）。

### 4. 主题包格式

```
my-theme/
├── theme.json      { name, version, author, license, variants: ["light","dark"], apiVersion }
├── theme.css
└── assets/         # 字体、背景图（相对路径引用）
```

用户主题放 `<userData>/themes/`，编辑器热加载（改 CSS 立即生效，方便调试）。
自带主题：Light / Dark / Sepia / High Contrast / GitHub 风格。

主题 CSS 加载时同样受 CSP 约束：不允许 `@import` 远程地址，`url()` 限定在主题包内。

## 二、插件

### 1. 能力范围

插件能做的事，按风险从低到高：

| 能力 | 需要权限声明 | 例子 |
| --- | --- | --- |
| 注册命令、快捷键 | 否 | 「插入当前日期」 |
| 注册状态栏 / 侧边栏面板 | 否 | 字数统计面板 |
| 读写**当前文档**（通过 transaction） | 否 | 排序选中行 |
| 注册语法扩展（三件套，见 03） | 否 | Wiki 链接、任务标记 |
| 注册导出格式 | 否 | 导出到 Anki |
| 读写工作区其他文件 | `workspace-read` / `workspace-write` | 双链索引 |
| 网络请求 | `network`（附域名白名单） | 图床上传、翻译 |
| 执行外部命令 | `shell`（附命令白名单） | 调用 pandoc |

### 2. 插件形态

```
my-plugin/
├── manifest.json
└── main.js          # ESM，默认导出 Plugin 类
```

```json
{
  "id": "com.example.wikilink",
  "name": "Wiki Links",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",
  "main": "main.js",
  "permissions": [
    { "type": "workspace-read", "reason": "解析 [[链接]] 指向的文件" }
  ],
  "settings": { /* JSON Schema，编辑器据此自动生成设置界面 */ }
}
```

```ts
export default class WikiLinkPlugin implements Plugin {
  async onLoad(ctx: PluginContext) {
    ctx.registerSyntax(wikiLinkSyntax)              // 三件套
    ctx.registerCommand({ id: 'wikilink.open', name: '打开链接', run: … })
    ctx.registerPanel({ id: 'backlinks', side: 'right', render: … })
    ctx.onDocumentChange(doc => …)                  // 自动在 onUnload 注销
  }
  async onUnload() {}  // 可选；ctx 注册的东西会自动清理
}
```

**设计要点**：`ctx` 上注册的一切都记录在案，插件卸载时自动注销。
不依赖插件作者写正确的清理代码 —— 否则热重载和禁用功能必然漏资源。

### 3. 权限与隔离

见 [ADR-0004](../adr/0004-plugin-isolation.md)。要点：

- 安装时展示权限清单与 `reason`，用户确认；
- 敏感能力（fs / network / shell）**不在渲染进程直接执行**，而是发 IPC 到 main，
  由 main 按该插件已授权的白名单二次校验后执行；
- **诚实的限制**：v1 插件与编辑器共享渲染进程的 JS 上下文，恶意插件可以绕开 API 层。
  权限模型防的是误用和「不小心装了个乱来的插件」，不是防定向攻击。
  真隔离（Worker / utility 进程 + RPC）列在 M6 之后的演进项里；
  在实现之前，插件市场页面必须明确写出这个限制，不做虚假承诺。

### 4. API 稳定性

- `@typo/plugin-api` 的 semver 就是插件 API 的 semver。
- 每个插件在 manifest 里声明 `apiVersion` 范围，不匹配则拒绝加载并提示。
- 破坏性变更只在 major 版本，且提前一个 minor 版本开始输出废弃警告。
- 内置功能（数学、图表、脚注）**用同一套 API 实现**，作为 API 的活体测试。
  如果内置功能需要走后门，说明 API 缺能力，该补 API 而不是开后门。
