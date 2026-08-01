# ADR-0001 · 桌面壳选 Electron 而非 Tauri

- 状态：已接受
- 日期：设计阶段

## 背景

需要一个跨平台桌面壳。主流选项：Electron、Tauri、Wails、纯 Web（PWA）。

## 决策

**采用 Electron**，同时把编辑器内核写成不依赖 Electron 的纯 Web 库
（架构 01 §4 的 `HostBridge`），保留将来换壳的可能。

## 理由

决定性因素是**渲染引擎的一致性**。本项目的全部价值集中在文本编辑体验上，
而文本编辑最脆弱的部分 —— 光标定位、选区、输入法组合、`contenteditable`
行为、字体度量、打印排版 —— 在不同浏览器引擎上差异巨大。

Tauri 使用系统 WebView：Windows 上是 WebView2（Chromium），macOS 上是 WKWebView，
Linux 上是 WebKitGTK。这意味着：

1. 同一份编辑器代码要在三种引擎上分别验证 IME、选区、装饰渲染；
2. Linux 的 WebKitGTK 在输入法与 `contenteditable` 上的已知问题最多，
   而这恰恰是我们的核心路径；
3. 用户装的系统 WebView 版本不可控，bug 报告会变成「你的系统 WebView 版本多少」的泥潭；
4. PDF 导出依赖打印引擎，三引擎的分页表现不一致，导出保真无法承诺。

Electron 打包固定版本的 Chromium，把上述所有问题压缩成一个已知量。
对一个小团队来说，这省下的调试时间远大于体积的代价。

其他考量：

- **生态**：CodeMirror、KaTeX、Mermaid 都在 Chromium 上验证最充分。
- **能力**：`printToPDF`、原生菜单、拼写检查、自动更新在 Electron 里都是成熟路径。
- **可招募性**：Electron 的中文资料与可复用经验远多于 Tauri。

## 代价（明确承认）

| 代价 | 缓解 |
| --- | --- |
| 安装包大（~100MB+） | 设预算 120MB 并在 CI 守住；懒加载重型依赖 |
| 内存占用高 | 设预算并做基准；大文档降级策略（02 §9） |
| 安全面更大（Node 在手边） | 架构 01 §6 的完整安全模型：contextIsolation、sandbox、CSP、路径校验 |
| 冷启动慢 | 预算 1.5s；V8 快照 / 代码缓存；渲染层代码分割 |

## 演进路径

`HostBridge` 是内核与壳的唯一接缝。如果将来 Tauri 的 Linux WebView 状况改善，
或者体积成为关键诉求，新增一个 Tauri 版 `HostBridge` 实现即可，内核零改动。
这个可能性是**设计出来的**，不是事后侥幸。

## 被否决的选项

- **Tauri**：见上。将来可作为第二个壳，不作为唯一壳。
- **Wails**：生态更小，Go 侧优势对本项目无用。
- **纯 Web / PWA**：File System Access API 在 Safari/Firefox 支持不全，
  且无法提供本地优先的文件监听、系统菜单、Pandoc 调用。作为 `apps/web` 的补充形态存在，
  不作为主形态。
