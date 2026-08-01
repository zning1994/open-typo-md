# Typo

一个开源的 Markdown 「所见即所得」编辑器 —— 无分屏、无预览窗格，写下的就是看到的。

> 状态：**设计阶段**。当前仓库只包含设计文档，代码尚未开始。
> 设计文档入口：[`docs/design/00-overview.md`](docs/design/00-overview.md)

---

## 这是什么

大多数 Markdown 编辑器是「左边源码 / 右边预览」。Typo 走另一条路：
只有一个编辑区，标题、粗体、表格、公式、图片都以最终形态呈现；
只有当光标进入某个元素时，它的 Markdown 标记才就地显形，供你直接编辑。

同类体验的商业产品是 [Typora](https://typora.io/)。Typo 是一个**独立实现**：
不复用其代码、资源或界面素材，只借鉴「无缝实时预览」这一交互范式。

## 核心设计取向

| 取向 | 说明 |
| --- | --- |
| **文件即真相** | 编辑器缓冲区里存的就是磁盘上那份 Markdown 文本，没有中间私有模型，往返零损耗 |
| **本地优先** | 工作区就是一个普通文件夹，不需要账号、不需要同步服务、不锁定数据 |
| **可嵌入的内核** | 编辑器内核是纯 Web 库，不依赖 Electron，可以被浏览器、VS Code、其他壳复用 |
| **扩展是一等公民** | 主题、语法扩展、面板都走公开 API，内置功能自己也用同一套 API |

完整的目标 / 非目标见 [设计总览](docs/design/00-overview.md)。

## 文档索引

**设计文档**

| 文档 | 内容 |
| --- | --- |
| [00 总览](docs/design/00-overview.md) | 产品定位、目标与非目标、设计原则 |
| [01 架构](docs/design/01-architecture.md) | 仓库结构、进程模型、模块边界、安全模型 |
| [02 编辑器内核](docs/design/02-editor-core.md) | 实时预览的实现模型（本项目最核心的部分） |
| [03 Markdown 管线](docs/design/03-markdown-pipeline.md) | 双解析器策略、往返保真、语法扩展 |
| [04 文件与工作区](docs/design/04-files-and-workspace.md) | 原子保存、文件监听、崩溃恢复、全文搜索 |
| [05 主题与插件](docs/design/05-themes-and-plugins.md) | 主题契约、插件 API、权限模型 |
| [06 导出](docs/design/06-export.md) | HTML / PDF / DOCX / LaTeX 导出管线 |
| [07 质量基线](docs/design/07-quality.md) | 测试策略、性能预算、无障碍、国际化 |
| [08 路线图](docs/design/08-roadmap.md) | 里程碑拆分与验收标准 |

**架构决策记录（ADR）**

| ADR | 决策 |
| --- | --- |
| [0001](docs/adr/0001-desktop-shell.md) | 桌面壳选 Electron 而非 Tauri |
| [0002](docs/adr/0002-editor-core.md) | 编辑器内核选 CodeMirror 6 而非 ProseMirror |
| [0003](docs/adr/0003-dual-parser.md) | 编辑解析器与语义解析器分离 |
| [0004](docs/adr/0004-plugin-isolation.md) | 插件隔离与权限模型 |

## 许可

[MIT](LICENSE)
