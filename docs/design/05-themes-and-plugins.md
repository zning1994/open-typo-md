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
  --typo-focus-dim: 0.35;          /* 专注模式下非当前块的不透明度 */
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

---

## 三、设置

### 1. 现在是手写的，不是 schema 驱动的

M4.5 给「设置界面」的判词是：**「用 schema 自动生成表单实质上是另起一个项目：
条件显隐、校验、分组、搜索、重置、迁移。」** 这话没错，但它描述的是一个**有几十
上百项设置的清单** —— 而那个清单当时不存在（整个应用只有一条 `appearance.theme`）。

让清单存在的是**插件**：上面二 §2 的 manifest 里那句
`"settings": { /* JSON Schema */ }`。所以通用化的正确时机是 M5，
那时才有几十项来自不同插件的设置需要统一渲染、统一校验、统一分组。

现在的做法：一个 `Preferences` 类型、一张默认值表、一个逐字段的校验器。
字段就这么几个，而**手写的校验器能说清楚为什么这个范围是这个范围**，schema 说不清。

### 2. 校验不是可选项

`settings.json` 就在用户数据目录里，明摆着让人直接改 —— 这是「不锁定用户数据」的
一部分，不是疏漏。所以读进来的每个值都可能是任何东西：字符串、null、数组，
或者手滑打成 `"A4 "`。

三条规则：

- **一个坏值只作废它自己**，其余字段照常生效。整份设置因为一个手滑而回到出厂状态，
  比那个手滑本身糟糕得多；
- **范围类的值夹住而不是拒绝**。页边距填 0 或者填很宽都是正当需求，
  只有超出纸张物理限制的才算错；
- **读不出来不报错、不提示**。设置项是锦上添花，为它挡在启动路径上不值当。

main 侧**再兜一次底**：PDF 的页边距在 `renderPdf` 里又校验了一遍。
渲染进程已经验过，但 main 不信任传进来的任何东西（01 §5），这条不因为「自己人传的」
而放松。

### 3. 面板是当前窗口里的浮层，不是新窗口

开窗口意味着再来一份渲染进程入口、一套自己的主题初始化、一条跨窗口同步设置的通路
—— 而设置项现在只有六条外加一张快捷键表，那些管道比它们要装的东西还重。

交互沿用命令面板那三条：Esc 与点遮罩都能关、关掉之后焦点回编辑器、浮层对读屏软件
是一个 `role="dialog"`。

**没有「确定 / 取消」，改一下就存一下。** 设置项之间没有依赖，也没有「一批改动要
一起生效」的语义。给一个确定按钮只会多出一种状态（改了但没提交），
以及一个必须回答的问题：关掉浮层算确定还是算取消。

### 4. 当前有哪些设置

| 设置 | 作用范围 |
| --- | --- |
| 主题 | 立即，全窗口 |
| 新标签页默认进源码模式 | **只影响新建的标签** |
| 渲染行内 HTML | 立即，所有已开标签 |
| 快捷键 | 立即（重建原生菜单） |
| 导出 PDF 的纸张 / 方向 / 页边距 | 下一次导出 |

「只影响新建的标签」是刻意的：改一个设置就把所有已打开标签的视图切一遍，
是很吓人的行为 —— 用户正在读的那篇文章会突然变成源码。

行内 HTML 那条**恰恰相反，必须立刻作用到所有标签**：用户勾掉它就是想现在看见
自己文件里到底写了什么。判据不是「哪种一致」，是「用户按下去时期待发生什么」。

### 5. 快捷键编辑

**第一步不是做界面，是把三份绑定合成一份。** 在此之前同一个绑定写在三个地方：
`main/menu.ts` 的 `accelerator`（`CmdOrCtrl+Shift+K`）、渲染进程给命令面板显示的
那份（`Mod+Shift+K`）、以及 CodeMirror 的 keymap（`Mod-Shift-k`）。格式互不相同，
改一处漏两处是必然的 —— 而「让用户能改」意味着三份都要跟着变。

现在唯一的真相是 `shared/keys.ts`，它同时被 main 与渲染进程 import，
并负责翻译成那三种目标格式。几条不那么显然的决定：

- **`Mod` 与 `Ctrl` 是两个不同的东西。** `Mod` 在 macOS 上是 ⌘、别处是 Ctrl；
  `Ctrl` 到哪儿都是 Control。切标签用 `Ctrl+Tab`，macOS 上也不该变成 ⌘Tab ——
  那是系统的。
- **修饰键顺序被规范化。** 冲突检测靠字符串相等，`Shift+Mod+K` 与 `Mod+Shift+K`
  不归一就会漏掉真冲突。
- **没有修饰键的组合一律拒绝**（功能键除外）：那会把一个字符键抢走，
  用户再也打不出这个字。
- **录制而不是让用户敲字符串。** 用户知道自己想按什么，未必知道该怎么拼它。
  录制期间吞掉所有按键 —— 否则你想绑 ⌘S，结果文档存了一次。
- **冲突只警告，不阻止。** 两条命令共用一个键在别的应用里也常见（上下文不同时
  各自生效），我们判断不了用户的上下文，所以只把事实摆出来。
- **改完立刻重建整个原生菜单。** Electron 没有「改一个 accelerator」的接口，
  而重建是几毫秒的事。这一步不能省：**真正拦住按键的是菜单**
  （菜单加速键优先于网页），界面显示新的、菜单还挂着旧的，是这个功能最可能的坏法。
- **解绑与恢复默认是两件事。** 设置里存空串是「这个命令从此没有快捷键」，
  把键删掉才是「回到出厂」。两件事用户都要做得到。

**明确不可配置的**：Tab / Enter / Backspace。它们不是「某个功能的快捷键」，
而是编辑行为本身 —— 表格里的 Tab 是「下一个单元格」，列表里的 Enter 是「续写
标记」。让用户把 Enter 改掉，等于让他把换行改掉。另外「新建窗口」（⌘N）也没进来，
它是 main 自己执行的窗口动作，不走命令表。

### 6. 还没进来的
- **用户主题目录与热加载**（M4 顺延项）。它要新增一条「读 userData 下的任意 CSS
  并注入」的通路，涉及 CSP 与路径白名单，跟内置主题不是一个量级。
- **附件目录名**。现在写死 `assets`。改它要动附件落盘那条路径的校验
  （目录名不能含分隔符、不能是 `..`），跟设置面板本身无关，单独做更稳妥。
