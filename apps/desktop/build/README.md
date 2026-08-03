# 打包资源（`buildResources`）

`electron-builder.yml` 里 `directories.buildResources` 指向这里。图标由
`scripts/icons.mjs` 生成，两份 `entitlements` 由 macOS 签名时使用。

## 为什么 entitlements 里一条注释都没有

因为**写了就签不了名**。

`codesign --entitlements` 那一头解析 plist 的不是 CFPropertyList，而是 AMFI
（AppleMobileFileIntegrity）自带的一个解析器，它是内核 `OSUnserializeXML` 的
变体，比标准 XML 严格得多。原来那两份文件带着大段中文注释、`<true />` 里有个
空格、也没有 DOCTYPE，`xmllint` 判定完全良构，但 codesign 一句话打回：

```
Failed to parse entitlements: AMFIUnserializeXML: syntax error near line 15
```

第 15 行正是第一个 `<true />`。三个可疑点（注释、`<true />` 的空格、缺
DOCTYPE）我们没有逐个试——每试一轮要十几分钟——而是直接改成 Electron 官方
文档里那份逐字规范的形式，一次排除干净。

所以这两个文件**必须保持规范形式**：有 DOCTYPE、`<true/>` 不带空格、里面不放
注释。`apps/desktop/test/entitlements.test.ts` 把这几条钉住了。要解释什么，
写在这个文件里。

## 这几条豁免项是干什么的

开启 hardened runtime 是**公证的前提** —— 没有它 notarytool 直接拒收。而
Electron 在 hardened runtime 下跑不起来，除非放开这几条：

| 键 | 为什么必须 |
| --- | --- |
| `allow-jit` / `allow-unsigned-executable-memory` | V8 要在运行时生成机器码。缺了它 Electron 20+ 在 arm64 上启动即崩 |
| `disable-library-validation` | `Electron.framework` 与几个 Helper 是上游预签名的，Team ID 跟我们的不同；库校验会拒绝加载它们 |
| `allow-dyld-environment-variables` | Electron 的启动脚本要靠 `DYLD_*` 定位自己的 framework |

这几条都会削弱 hardened runtime 的保护，但它们是 Electron 应用的标准配置
（`@electron/osx-sign` 的默认模板就是这些）。**不是随手加的**：每去掉一条都
可以自己验证一遍，表现是启动即崩或者白屏。

App Store 那条路要的是另一套（App Sandbox + user-selected 文件权限），跟这两
份文件不通用 —— 见 `docs/design/07-quality.md` §6。

## 为什么有两份，而且内容一样

签名是**逐个 bundle** 做的，主程序的 entitlements 不会自动传给 Helper。
`entitlements.mac.inherit.plist` 给的是子进程（`Helper`、`Helper (Renderer)`、
`Helper (GPU)`…）和内嵌 framework。少了它的表现是主进程起得来、渲染进程一开
就崩 —— 而那看起来完全不像签名问题。

内容必须跟主文件一致，这条也由上面那个测试钉住。

这里**没有** `com.apple.security.inherit`：那个键是 App Sandbox 的继承机制，
而 Developer ID 分发不开沙盒，写了也不起作用。
