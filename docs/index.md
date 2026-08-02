---
layout: home

hero:
  name: Brainforge Typo
  text: 写下的就是看到的
  tagline: 开源的 Markdown 所见即所得编辑器。无分屏，无预览窗格，只有一个编辑区。
  actions:
    - theme: brand
      text: 看设计文档
      link: /design/00-overview
    - theme: alt
      text: GitHub
      link: https://github.com/zning1994/open-typo-md
    - theme: alt
      text: 路线图
      link: /design/08-roadmap

features:
  - title: 源码优先，往返零损耗
    details: 编辑器缓冲区里存的就是磁盘上那份 Markdown 文本，没有中间私有模型。打开再保存，文件逐字节不变 —— 包括编码、换行风格、你原本用的是 * 还是 _。
  - title: 光标进入才显源码
    details: 标题、粗体、链接、图片平时都以最终形态呈现；光标走进某个元素，它的 Markdown 标记才就地显形供你编辑。中日韩输入法在装饰区域内正常工作，有专门的回归用例守着。
  - title: 本地优先，不锁定数据
    details: 工作区就是一个普通文件夹。不需要账号，不需要同步服务。设置文件是明文 JSON，摆在那里让你直接改。
  - title: 内核可以脱离 Electron
    details: 编辑器内核是纯 Web 库，不 import 任何 Node/Electron API，宿主能力全部靠注入。浏览器或别的壳都能复用。
---

## 现在是什么状态

**能用了，但还没有正式发布。** 版本 0.1.0，M4.5 那一档刚做完：

GFM（表格 / 任务列表 / 删除线 / 脚注）、数学公式、Mermaid 图表、大纲面板、
命令面板、崩溃恢复、6 套主题、HTML / PDF 导出、复制为富文本、粘贴 HTML 自动转
Markdown、表格编辑、文件树、多标签页、会话恢复、设置面板、行内 HTML 渲染、
快捷键自定义 —— 都已经可用。

**还没有**：插件系统（M5）、用户主题目录与热加载、块级 HTML 渲染、表格拖拽调
列宽、PDF 的页眉页脚与目录页码、文件树里的重命名 / 新建 / 删除。

各里程碑「明确没做的部分」逐条写在[路线图](/design/08-roadmap)末尾的「实际偏差」里。
不藏着掖着 —— 那份清单本身就是这个项目的一部分。

## 想先试试

还没有打过正式的 release，但每次推到 `main` 都会在
[Actions](https://github.com/zning1994/open-typo-md/actions) 里产出三个平台的包。

⚠️ **这些包都没有签名。** macOS 上首次打开会被 Gatekeeper 拦下（需要右键 → 打开，
或去「系统设置 → 隐私与安全性」放行），Windows 上会被 SmartScreen 提示。
不是应用有问题，是还没配开发者证书 —— 具体缘由与解法写在
[07 §6.1](/design/07-quality#_6-1-macos-签名与公证-gatekeeper-那一关)。

自己从源码跑更省事：

```bash
pnpm install
pnpm dev
```

## 为什么值得读它的设计文档

大多数编辑器的文档在讲「有什么功能」。这里讲的是**取舍**，以及**错在哪儿**：

- [为什么选 CodeMirror 6 而不是 ProseMirror](/adr/0002-editor-core) —— 富文本编辑器的
  文档模型天然要求一个中间表示，而那正好跟「源码即真相」冲突；
- [为什么用两个 Markdown 解析器](/adr/0003-dual-parser) —— 编辑要增量与位置精确，
  导出要语义完整，一个解析器同时干这两件事只会两头不讨好；
- [macOS 上 PDF 导出空白页追了七轮 CI](/design/06-export#_3-3-曾经的缺陷-macos-上产出空白页-已修) ——
  连着提出并推翻了六个结论，最后靠「把变量铺开量」定位到一个字体；
- [渲染文档里的 HTML 怎么做到不解析 HTML](/design/02-editor-core#_5-1-行内-html-不解析-html-也能渲染-html) ——
  绕开消毒器那条路，因为消毒器漏一个就是 XSS→RCE。

## 跟 Typora 的关系

同类体验的商业产品是 [Typora](https://typora.io/)。本项目是一个**独立实现**：
不复用其代码、资源或界面素材，只借鉴「无缝实时预览」这一交互范式。
两者没有任何关联。
