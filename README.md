# Typo

一个开源的 Markdown 「所见即所得」编辑器 —— 无分屏、无预览窗格，写下的就是看到的。

> **状态：M1 完成**（实时预览内核可用）。可以打开、编辑、保存 CommonMark 文档。
> 表格、数学公式、文件树、主题、插件尚未实现 —— 见[路线图](docs/design/08-roadmap.md)。

---

## 这是什么

大多数 Markdown 编辑器是「左边源码 / 右边预览」。Typo 走另一条路：
只有一个编辑区，标题、粗体、链接、图片都以最终形态呈现；
只有当光标进入某个元素时，它的 Markdown 标记才就地显形，供你直接编辑。

同类体验的商业产品是 [Typora](https://typora.io/)。Typo 是一个**独立实现**：
不复用其代码、资源或界面素材，只借鉴「无缝实时预览」这一交互范式。

## 核心设计取向

| 取向              | 说明                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| **文件即真相**    | 编辑器缓冲区里存的就是磁盘上那份 Markdown 文本，没有中间私有模型，往返零损耗 |
| **本地优先**      | 工作区就是一个普通文件夹，不需要账号、不需要同步服务、不锁定数据           |
| **可嵌入的内核**  | 编辑器内核是纯 Web 库，不依赖 Electron，可以被浏览器、其他壳复用           |
| **扩展是一等公民** | 主题、语法扩展、面板都走公开 API，内置功能自己也用同一套 API              |

完整的目标 / 非目标见[设计总览](docs/design/00-overview.md)。

## 快速开始

需要 Node ≥ 20.19 与 pnpm。

```bash
pnpm install
pnpm dev          # 启动开发版（渲染进程带 HMR，main/preload 改动自动重启）
```

其他常用命令：

```bash
pnpm test         # 单元测试（含 CommonMark 全量语料的保真与不变量检查）
pnpm test:e2e     # 端到端测试（真 Electron + 真 Chromium，含输入法用例）
pnpm verify       # 提交前跑一遍：分层检查 + 类型 + lint + 格式 + 单测
pnpm build        # 构建 main / preload / renderer
pnpm --filter @typo/desktop package     # 打出当前平台的安装包
```

Linux 上跑端到端测试需要一个显示环境：`xvfb-run -a pnpm test:e2e`。

## 目前能做什么

**可以用了**

- CommonMark 全集的实时预览：标题、强调、行内代码、链接、图片、列表、引用、代码块、分隔线
- 光标进入元素即显源码，移开即还原；光标不会落进看不见的标记里
- 中日韩输入法在装饰区域内正常工作（有专门的回归用例守着）
- 打开 / 保存 / 另存为，原子写入，外部修改冲突检测
- 编码与换行风格保真：打开→保存后文件逐字节不变
- 加粗 / 斜体 / 行内代码 / 标题层级的快捷键，回车续列表，撤销重做，查找替换
- Ctrl / Cmd + 点击链接用系统浏览器打开（普通点击只定位光标）
- 源码模式一键切换

**还没有**（按路线图排期）

- 表格、任务列表、删除线等 GFM 语法（M2）
- 文件树、标签页、大纲、数学公式、图表（M3）
- 主题引擎、HTML / PDF 导出（M4）
- 插件系统（M5）

## 试用 CI 构建的安装包

每次推到 `main`，[Actions](https://github.com/zning1994/open-typo-md/actions) 里会产出三个平台的安装包。
注意页面上显示的 `typo-macos-arm64-dmg` 这类名字是**产物包**的名称，不是文件名 ——
GitHub 一律把产物打成 zip，解开之后才是 `Typo-0.1.0-arm64.dmg`。

**这些包都没有签名**，因为签名证书还没配（M6 的发布工程内容，见 docs/design/07 §7）。
所以首次打开会被系统拦下来：

**macOS** —— 提示「"Typo" 已损坏，无法打开。你应该将它移到废纸篓」。
应用没有损坏，这是 Gatekeeper 对未签名应用的（相当误导人的）说法。
把应用拖进 `/Applications` 之后执行：

```bash
xattr -dr com.apple.quarantine /Applications/Typo.app
```

**Windows** —— SmartScreen 提示「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。

**Linux** —— AppImage 需要先加执行权限：

```bash
chmod +x Typo-*.AppImage && ./Typo-*.AppImage
```

## 仓库结构

```
packages/
  plugin-api/   宿主接口与公开类型（HostBridge、内存实现）
  markdown/     文本保真编解码、Lezer 语法配置、大纲派生
  editor/       实时预览内核（装饰引擎、命令、主题）
apps/
  desktop/      Electron 壳（main / preload / renderer）
e2e/            Playwright 端到端测试
docs/           设计文档与架构决策记录
```

依赖方向严格单向向下，由 `pnpm layers` 在 CI 里强制。

## 文档索引

**设计文档**

| 文档                                                   | 内容                                     |
| ------------------------------------------------------ | ---------------------------------------- |
| [00 总览](docs/design/00-overview.md)                   | 产品定位、目标与非目标、设计原则          |
| [01 架构](docs/design/01-architecture.md)               | 仓库结构、进程模型、模块边界、安全模型    |
| [02 编辑器内核](docs/design/02-editor-core.md)          | 实时预览的实现模型（本项目最核心的部分）  |
| [03 Markdown 管线](docs/design/03-markdown-pipeline.md) | 双解析器策略、往返保真、语法扩展          |
| [04 文件与工作区](docs/design/04-files-and-workspace.md) | 原子保存、文件监听、崩溃恢复、全文搜索    |
| [05 主题与插件](docs/design/05-themes-and-plugins.md)   | 主题契约、插件 API、权限模型              |
| [06 导出](docs/design/06-export.md)                     | HTML / PDF / DOCX / LaTeX 导出管线        |
| [07 质量基线](docs/design/07-quality.md)                | 测试策略、性能预算、无障碍、国际化        |
| [08 路线图](docs/design/08-roadmap.md)                  | 里程碑拆分与验收标准                      |

**架构决策记录（ADR）**

| ADR                                          | 决策                              |
| -------------------------------------------- | --------------------------------- |
| [0001](docs/adr/0001-desktop-shell.md)        | 桌面壳选 Electron 而非 Tauri       |
| [0002](docs/adr/0002-editor-core.md)          | 编辑器内核选 CodeMirror 6 而非 ProseMirror |
| [0003](docs/adr/0003-dual-parser.md)          | 编辑解析器与语义解析器分离         |
| [0004](docs/adr/0004-plugin-isolation.md)     | 插件隔离与权限模型                 |

## 参与开发

改代码前建议先读 [02 编辑器内核](docs/design/02-editor-core.md)——
装饰引擎的规则是整个项目最容易改错的地方，那份文档解释了每条规则为什么长这样。

提 PR 前请跑 `pnpm verify`。涉及装饰规则的改动，务必说明对格式保真的影响。

## 许可

[MIT](LICENSE)
