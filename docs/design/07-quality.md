# 07 · 质量基线

## 1. 测试分层

| 层 | 工具 | 覆盖什么 | 跑的频率 |
| --- | --- | --- | --- |
| 单元 | Vitest | 解析器、序列化、装饰规则、路径解析、冲突判定 | 每次提交 |
| 规范符合性 | Vitest + CommonMark/GFM 官方用例 | 两个解析器的一致性（见 03 §1） | 每次提交 |
| 往返属性测试 | Vitest + fast-check | `parse(serialize(parse(x))) == parse(x)`；`open→save == 原字节` | 每次提交 |
| 编辑器交互 | Playwright（真 Chromium） | 光标穿越隐藏标记、IME、表格 widget、撤销 | 每次 PR |
| 端到端 | Playwright + Electron | 开关文件、外部修改冲突、崩溃恢复、导出 | 每次 PR |
| 性能基准 | 自建 + CI 基线对比 | 见 §2 | 每次 PR |
| 视觉回归 | Playwright 截图对比 | 各内置主题 × 各元素类型 | 每次 PR |

### 必须有的几组「防灾」测试

这些直接对应最可能出事故的地方：

1. **保真闭环**：拿一批真实世界的 `.md`（CommonMark 用例 + 若干开源项目 README +
   刻意构造的畸形文档），逐个「打开 → 保存」，断言字节完全一致。
2. **IME 三语用例**：中文拼音、日文假名转换、韩文组字，各在「装饰区域内」
   「表格单元格内」「块公式旁」三种位置输入，断言无丢字、无错位。
3. **崩溃恢复**：进程被 `SIGKILL` 后重启，断言草稿可恢复且内容正确。
4. **并发写**：编辑器保存的同时外部程序改文件，断言不产生静默覆盖。
5. **未知语法保留**：喂入包含自定义语法、原始 HTML、异常嵌套的文档，断言原样保留。

## 2. 性能预算与守护

预算（见 00 · G1、03 §6）在 CI 里是**硬门槛**，不是参考值：

| 指标 | 预算 | 回退容忍 |
| --- | --- | --- |
| 按键 → 渲染完成 p95（1k 行） | 16ms | 超过即失败 |
| 打开 10k 行文档到可编辑 | 300ms | 相对基线 +20% 即失败 |
| 冷启动到可输入 | 1.5s | 相对基线 +20% 即失败 |
| 主 bundle 体积（不含懒加载） | 3MB | +10% 需说明 |
| 安装包体积 | 180MB | +10% 需说明；M3 末实测 Linux AppImage 113.6MB（含 KaTeX 与 Mermaid） |
| 空闲内存占用（打开 1 个中等文档） | 300MB | 参考 |

基线数据存在仓库里，随性能优化 PR 一起更新。Mermaid、KaTeX、语言高亮包
一律懒加载，禁止进主 bundle（用 bundle 分析在 CI 里守住）。

## 3. 无障碍

- 编辑区必须能被屏幕阅读器正确朗读。隐藏 Markdown 标记时用
  `aria-hidden` + 恰当的语义标签，让读屏软件读到「标题 二级：安装」而不是「井号 井号 安装」。
- 块 widget（表格、公式）提供 `aria-label` 描述；公式带 LaTeX 源码作为替代文本。
- 全键盘可达：所有命令有可绑定的快捷键，命令面板覆盖全部命令，
  焦点顺序合理，widget 可用键盘进入与退出（Enter 进 / Esc 出）。
- 对比度满足 WCAG AA；内置一个高对比度主题。
- 尊重 `prefers-reduced-motion`：关闭动画。

无障碍不进 CI 门槛不现实，但至少：axe-core 扫主要界面，违规项进看板。

## 4. 国际化

- UI 文案全部走 ICU MessageFormat，不硬编码。
- 首批语言：简体中文、English。社区可提交其他语言。
- **RTL 支持**：界面镜像 + 编辑区 `dir` 检测。Markdown 内容与 UI 方向独立。
- 快捷键按平台差异化（macOS `⌘` vs 其他 `Ctrl`），且完全可自定义。
- 日期、数字格式跟随系统区域。
- 拼写检查：接系统词典（macOS/Windows 原生 API，Linux 用 hunspell），支持多语言与自定义词典；
  代码块、行内代码、公式、URL 内不检查。

## 5. 工程规范

- TypeScript `strict` + `noUncheckedIndexedAccess`；不允许 `any` 逃逸（`@typescript-eslint` 强制）。
- ESLint + Prettier，pre-commit 钩子（lint-staged）。
- `dependency-cruiser` 强制 01 §1 的分层依赖方向。
- Conventional Commits；语义化版本；CHANGELOG 自动生成。
- 每个 PR 必须说明：改了什么、怎么测的、有没有影响格式保真。
- 新依赖需要在 PR 里说明必要性与许可（必须 MIT 兼容）。

## 6. CI 流水线

```
push / PR
 ├─ lint + typecheck + 依赖方向检查
 ├─ 单元 + 规范符合性 + 属性测试
 ├─ 构建三平台（macOS / Windows / Linux）
 ├─ Playwright 交互 + E2E（三平台）
 ├─ 性能基准对比
 ├─ bundle 体积检查
 └─ 视觉回归

tag v*
 ├─ 打包 + 代码签名（macOS 公证 / Windows Authenticode）
 ├─ 生成 CHANGELOG + Release
 └─ 发布更新源（供自动更新使用）
```

代码签名证书通过仓库 Secret 管理，只在 tag 触发的流水线里可用，
fork 的 PR 拿不到（必须在 workflow 里显式限制）。

## 7. 发布与更新

- 渠道：stable / beta。beta 用户可在设置里切换。
- 自动更新：下载后提示重启安装，**绝不静默替换正在运行的程序**。
- 更新包签名校验失败一律拒绝安装并上报。
- 提供便携版（免安装），配置写在程序目录旁而不是用户目录。
