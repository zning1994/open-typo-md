# 06 · 导出

## 1. 统一管线

所有导出共用前半段，只在最后一步分叉：

```
缓冲区文本
    │  remark（语义解析器，见 03）
    ▼
  mdast
    │  转换阶段：解析 [TOC]、内联脚注、解析相对图片路径、应用导出选项
    ▼
 mdast'
    │  mdast → hast
    ▼
  hast ──┬──▶ HTML（自包含单文件）
         ├──▶ PDF（Chromium 打印）
         └──▶ 交给 Pandoc ──┬──▶ DOCX
                            ├──▶ ePub
                            └──▶ LaTeX
```

导出在 **utility 进程**里跑，不阻塞编辑；长任务显示进度并可取消。

## 2. HTML

两种模式：

| 模式 | 说明 |
| --- | --- |
| **自包含单文件**（默认） | CSS 内联、图片转 data URI、KaTeX 字体内嵌、图表转内联 SVG。一个文件发出去就能看 |
| 带资源目录 | 输出 `foo.html` + `foo.assets/`，适合体积大的文档 |

选项：是否包含目录、是否包含 YAML front matter、代码高亮主题、
是否内联 `<style>` 还是外链、页面宽度。

安全：导出的 HTML 同样经过消毒，不能因为「导出」就把用户文档里的 `<script>` 带出去
（除非用户显式勾选「保留原始 HTML」并确认风险）。

## 3. PDF

用 Chromium 的打印能力（Electron `webContents.printToPDF`），在**隐藏窗口**里
加载上一步生成的 HTML 后打印。

- 复用当前主题的 `@media print` 样式 —— 这就是为什么打印样式是主题契约的一部分。
- 支持：纸张尺寸、方向、页边距、缩放、是否打印背景、页眉页脚模板（页码 / 标题 / 日期）。
- 分页控制通过 CSS：`break-before/after`、`break-inside: avoid`（表格、代码块、图片默认避免断开）。
- **已知限制**（要在 UI 里说清楚，不要让用户以为是 bug）：
  Chromium 对 CSS Paged Media 的支持有限，做不到 `@page :left/:right` 差异化页眉、
  精确的交叉引用页码、目录自动页码。需要这些的用户走 Pandoc → LaTeX 路线。

## 4. Pandoc 集成（可选）

**不打包 Pandoc**。Pandoc 是 GPL，打进 MIT 应用的发行版会带来许可传染争议。
做法：

- 启动时探测 `pandoc` 是否在 PATH（或用户在设置里指定路径）；
- 探测到才在导出菜单里显示 DOCX / ePub / LaTeX / RTF 等项；
- 未探测到时，菜单项显示为「需要安装 Pandoc」并给出安装指引链接；
- 调用方式：以子进程运行，stdin 传 Markdown（不是 HTML —— Pandoc 自己解析 Markdown
  质量更高），参数里指定 `--from=gfm+tex_math_dollars+footnotes` 等按当前启用的语法拼装；
- 支持用户自定义 reference doc（`--reference-doc=my-template.docx`）与 LaTeX 模板。

**DOCX 兜底路径**：没有 Pandoc 时提供一个基于 `docx` npm 库的基础导出
（标题、段落、列表、表格、图片、加粗斜体、代码块）。明确标注为「基础保真度」，
不承诺复杂排版。这样至少「导出 Word」不是完全不可用。

## 5. 其他导出

- **复制为 HTML / 富文本**：写入剪贴板的 `text/html`，直接粘进 Word、邮件、飞书。
  这是日常使用频率最高的「导出」，优先级要高于 DOCX。
- **图片导出**：把选中区域或整篇渲染成 PNG（隐藏窗口截图），适合发社交媒体。
- **导出为纯 Markdown 变体**：例如把本地图片改成 base64、把脚注内联，用于发到不支持
  附件的平台。

## 6. 导入

- 从 DOCX / HTML 导入 → Markdown（有 Pandoc 用 Pandoc，否则 HTML 走 rehype-remark）。
- 粘贴富文本自动转 Markdown（见 02 §7），这条路径日常用得最多。

## 7. 导出配置的持久化

导出选项按「格式 + 工作区」记住上次的选择。支持**导出预设**：
用户把常用组合存成命名预设（例如「投稿用 PDF」「博客用 HTML」），一键复用。
预设存在工作区 `.typo/` 下，可随仓库共享。
