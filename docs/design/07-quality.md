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

### 6.1 macOS 签名与公证：Gatekeeper 那一关

**先说清楚这一关不能靠代码绕过。** 当前 CI 打出来的包带的是 ad-hoc 签名
（`scripts/after-pack.mjs`），它只解决「Apple Silicon 上能不能执行」——
所以「已损坏，无法打开」那句误导性提示消失了，但**每次安装仍会被 Gatekeeper
拦下**，用户要右键 → 打开，或者去「系统设置 → 隐私与安全性」点「仍要打开」。

解除拦截只有一条路：**Developer ID 签名 + 公证（notarization）**。
公证过的包双击即开，一句提示都没有。这需要一个 Apple Developer Program 账号
（99 美元/年），没有免费替代品。

除证书之外的一切都已经配好了：

| 已就位 | 位置 |
| --- | --- |
| Hardened Runtime 豁免项 | `apps/desktop/build/entitlements.mac.plist`（+ `.inherit.plist`） |
| 签名策略（有证书就签、没有就跳过） | `electron-builder.yml` 的 `mac` 段刻意不写 `identity` |
| 公证开关 | `release.yml` 检测到 `APPLE_TEAM_ID` 时加 `-c.mac.notarize=true` |
| 签名状态可见 | `release.yml` 的「记录签名状态」步骤写进 job summary |

**拿到账号之后要做的三件事：**

1. 在 Apple Developer 后台建一张 **Developer ID Application** 证书
   （不是 Mac App Distribution —— 那张是 App Store 用的，装到这里公证会被拒），
   导出成 `.p12` 并设一个密码；
2. `base64 -i cert.p12 | pbcopy`，把结果存成仓库 Secret `CSC_LINK`，
   密码存成 `CSC_KEY_PASSWORD`；
3. 建一个 **App-Specific Password**（appleid.apple.com → 登录与安全），
   连同 Apple ID 与 Team ID 存成 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
   `APPLE_TEAM_ID`。

三个 secret 齐了，下一次 tag 推上去就是签名 + 公证 + 装订（staple）的包。

**几个容易踩的点：**

- **Apple 更推荐用 App Store Connect API Key**（`APPLE_API_KEY` /
  `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`）而不是 App-Specific Password ——
  前者可单独吊销、不绑定个人 Apple ID。代价是 `APPLE_API_KEY` 是个 `.p8`
  **文件路径**，CI 里要多一步把 secret 写成临时文件。想换的话改 `release.yml`
  那一处 env 即可。
- **公证是异步的**，Apple 那边排队几分钟到几十分钟都有可能，发布作业会一直等。
  第一次跑记得把作业超时放宽。
- **公证失败最常见的原因是 entitlements 或 hardened runtime 没开**。
  这两样已经配好了，但如果将来引入了原生模块（`.node`），它必须**单独签名**，
  否则公证日志里会报 “The binary is not signed with a valid Developer ID
  certificate”。目前三个进程的产物都是自包含 JS，没有这个问题。

**只讲流水线怎么搭。走哪条分发路线、代价是什么，在 [09 分发](09-distribution.md)** ——
包括 Mac App Store 那条路上的架构冲突（App Sandbox 跟会话恢复、附件写盘、文件
监听三处正面撞车），以及为什么现在还不该收费。

### 6.2 Windows 签名：为什么现在先不做

SmartScreen（「Windows 已保护你的电脑」）跟 Gatekeeper 是同一类问题，
但**解除拦截的条件完全不同**，而这个差别决定了投入产出：

| | macOS | Windows |
| --- | --- | --- |
| 签名之后 | 还要公证，公证完**立刻**双击即开 | 签了名**不代表不弹窗** |
| 生效方式 | 确定性的 | 靠**声誉**积累 —— 安装量够多了才不弹 |

**OV 证书签完，SmartScreen 照样弹**，要等签名积累够安装量；只有 **EV 证书**
立刻获得声誉。对一个还没有用户的项目，OV 等于花了钱还是弹窗 ——
而「等安装量」的前提是有人愿意穿过弹窗去装。

**而且 macOS 那套「p12 塞进 secret」的路子在 Windows 上已经不成立。**
CA/浏览器论坛从 2023 年 6 月起要求所有代码签名私钥存在硬件里（HSM / USB 令牌），
OV、EV 都一样 —— GitHub 托管的 runner 插不了 U 盘。现在可行的只有两类：

- **云签名服务**（Azure Trusted Signing、DigiCert KeyLocker、SSL.com eSigner）：
  私钥在服务商的 HSM 里，给一个能从 CI 调的签名接口。其中 Azure Trusted Signing
  便宜得多，但**资格条件要按当下的官方条款确认**（对组织成立年限有过要求，
  个人开发者的政策变过）。
- **Certum 的开源证书**：对开源项目价格很低，但发的是实体卡，
  意味着只能在本机签，或者搭一台自托管 runner。

**结论：先不买。** macOS 那 99 美元/年换来的是确定的「双击即开」，值；
Windows 这边花更多钱，OV 换不来立刻不弹窗，EV 又贵还得配云签名 ——
而现在没有用户，声誉积累无从谈起。用户点两下「更多信息 → 仍要运行」能装，
README 里写清楚了。等真有下载量、或者开始收费，再回头算这笔账。

`release.yml` 里给 Windows 留的 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`
是**经典 p12 那条路**的接口。走云签名的话这两个变量用不上，
要换成各家的签名钩子（electron-builder 支持自定义 `sign` 脚本）——
等真选了服务商再改，现在写死反而是负担。

### 6.3 官网 / 文档站

`docs/` 目录**本身**就是站点源码（VitePress），由 `.github/workflows/pages.yml`
发到 GitHub Pages。不另建一个 `site/` 再把文档复制过去 —— 那会多出一份必然
漂移的副本，而 README 里指向 `docs/…` 的链接在 GitHub 上也就不再有效。

只在 `docs/**`、`README.md` 或站点配置变动时触发：每次改代码都重新部署一遍站点
纯属浪费，也会让部署历史里全是与站点无关的记录。

**自定义域名** `typo.ohgiantai.com`（跟 `appId` 的 `com.ohgiantai.typo` 同源）。
两处必须一致，改一处就得改另一处：

- `docs/public/CNAME` —— VitePress 把 `public/` 原样拷进产物根目录，
  GitHub Pages 读它来配置域名；
- `docs/.vitepress/config.ts` 里的 `SITE` 与 `base` —— 自定义域名下站点挂在
  域名根，`base` 必须是 `/`。退回 `<user>.github.io/<repo>/` 时要改回
  `/open-typo-md/`，**否则所有资源 404，而表现是「页面出来了但一片空白」**，
  不容易一眼看出是 base 的问题。

**站点定位是设计文档，不是用户手册。** 这是刻意的：现在最值得读的就是那些取舍
与被推翻的结论，而功能清单 README 里已经有了。

顺带一提，接 VitePress 的第一次构建就抓出了一个真问题：`02-editor-core.md`
里有个没闭合的代码围栏，导致从 §6.3 到文件末尾整段被当成代码块 ——
GitHub 上一直也是这么渲染的，没人发现。**多一个渲染器就多一双眼睛。**

### 6.4 截图是脚本拍的，不是手工截的

`pnpm screenshots`（Linux 上 `xvfb-run -a pnpm screenshots`）跑一遍真应用，
把官网与 README 用的图拍进 `docs/public/shots/`。

**理由只有一条：手工截的图会过期，而且没人会注意到它过期了。** 界面改了、
主题调了、某个功能重做了，图还停在半年前 —— 读者据此形成的第一印象是错的。
脚本化之后重拍的成本是一条命令，过期就没有借口。

顺带还有一个好处：图里那张表格的列宽、那段公式的排版、那张流程图，
**都是产品自己算的**，不是设计稿。看图等于看真东西。

几条实现上的选择：

- **`--force-device-scale-factor=2`**：CI 机器的 DPR 是 1，不强制拉高的话
  Retina 屏上看是糊的；强制之后任何机器拍出来的尺寸都一致，diff 才有意义。
- **冻住插入符的闪烁动画**（而不是隐藏光标）：不冻的话同一条命令跑两次得到
  两张不同的图；而光标本身正是「显形」那两张对比图要说明的东西。
- **按元素定位，不按滚动距离**：`scrollIntoView` 到某个标题，而不是滚 N 像素。
  猜距离的写法一改文档就拍歪，而且**拍歪了 CI 也不会报错** —— 图还是能出。
- **图提交进仓库**：让 Pages 的构建去跑一遍 Electron 太重，而图的更新频率
  远低于代码。

### 6.5 CI 产物是 zip，Release 产物不是

Actions 页面上下载到的永远是 zip —— 那是 `actions/upload-artifact` 的固有行为
（GitHub 一律把产物打包），跟我们的配置无关，也改不掉。所以 CI 里那几个
`typo-macos-arm64-dmg` 之类的名字指的是**产物包**，解开才是安装包。

Release 走的是 `electron-builder --publish always`，它把 `.dmg` / `.exe` /
`.AppImage` / `.deb` **原样**传成 release asset，用户点了直接就是安装包。

会多出两样东西，都不是包装：

- **macOS 的 `.zip`** —— Squirrel.Mac 自动更新只认 zip 不认 dmg。自动更新还没做
  （M6），现在确实多余，但留着省一次改配置；
- **`latest*.yml`** —— electron-updater 的元数据，同理。

**一个只有全量矩阵才会踩的坑**：`nsis` 与 `portable` 都产出 `.exe`，
套同一个全局 `artifactName` 会解析成同一个文件名，后打的覆盖先打的。
CI 只打 nsis，所以它一直藏着。现在 `portable` 有自己的命名模板。

### 6.6 为什么发布作业是串行的

三个平台都带 `--publish always`，而草稿 release 的语义是「没有就建一个」。
并发时三个作业会同时发现「没有」，于是各建一个 —— 产物散落在两三个草稿里，
或者其中两个直接报「已存在」失败。所以 `release.yml` 里写了 `max-parallel: 1`。
代价是墙钟时间三倍，而发布一年也没几次。

## 7. 发布与更新

- 渠道：stable / beta。beta 用户可在设置里切换。
- 自动更新：下载后提示重启安装，**绝不静默替换正在运行的程序**。
- 更新包签名校验失败一律拒绝安装并上报。
- 提供便携版（免安装），配置写在程序目录旁而不是用户目录。
