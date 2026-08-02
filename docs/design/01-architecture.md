# 01 · 架构

## 1. 分层

```
┌──────────────────────────────────────────────────────────────┐
│  apps/desktop        Electron 壳（窗口、菜单、托盘、更新）       │
│  apps/web            浏览器版（File System Access API）        │
└───────────────────────────┬──────────────────────────────────┘
                            │  HostBridge（注入式接口）
┌───────────────────────────┴──────────────────────────────────┐
│  @mosu/ui            侧边栏、大纲、命令面板、设置、状态栏        │
├──────────────────────────────────────────────────────────────┤
│  @mosu/editor        实时预览编辑器内核（CodeMirror 6）         │
├──────────────────────────────────────────────────────────────┤
│  @mosu/markdown      语法定义、增量解析、AST、序列化            │
├──────────────────────────────────────────────────────────────┤
│  @mosu/plugin-api    插件与主题的公开类型契约（仅类型 + 常量）   │
└──────────────────────────────────────────────────────────────┘
   @mosu/export   @mosu/themes    ← 依赖 markdown / plugin-api
```

**依赖方向严格单向向下。** `@mosu/markdown` 不认识编辑器，`@mosu/editor` 不认识 UI，
`@mosu/ui` 不认识 Electron。CI 用 `dependency-cruiser` 强制这条规则，违反即失败。

## 2. 仓库结构

pnpm workspace + TypeScript project references，单仓多包。

```
open-typo-md/
├── apps/
│   ├── desktop/            # Electron：main / preload / renderer 入口
│   │   ├── src/main/       #   窗口、菜单、IPC 处理、文件服务
│   │   ├── src/preload/    #   contextBridge 暴露的受控 API
│   │   └── src/renderer/   #   组装 @mosu/ui + @mosu/editor
│   └── web/                # 浏览器演示版
├── packages/
│   ├── markdown/           # 见 03
│   ├── editor/             # 见 02
│   ├── i18n/               # ICU 子集与翻译器，见 07 §4
│   ├── ui/
│   ├── themes/             # 见 05
│   ├── export/             # 见 06
│   └── plugin-api/
├── docs/
│   ├── design/
│   └── adr/
├── e2e/                    # Playwright 端到端
└── benchmarks/             # 性能基准（CI 跑，见 07）
```

`@mosu/plugin-api` 单独成包的原因：插件作者只需要装这一个包（纯类型，零运行时），
不必把整个编辑器拉进依赖树；同时它的 semver 就是插件 API 的 semver。

`@mosu/i18n` 是跟 `plugin-api` 并列的**叶子**：它只做字符串处理，谁也不认识。
文案表本身不在这个包里 —— 它在 `apps/desktop/src/shared/messages/`，因为那是应用的
内容而不是机制。编辑器内核的那 6 条可见文字走注入，不经过这个包（07 §4.5）。

## 3. 进程模型（Electron）

| 进程 | 职责 | 禁止 |
| --- | --- | --- |
| **main** | 窗口生命周期、原生菜单、系统对话框、文件读写、文件监听、自动更新、调用 Pandoc | 不做任何 Markdown 解析 |
| **preload** | 通过 `contextBridge` 暴露一层**收窄的、类型化的** API | 不暴露 `ipcRenderer` 本体、不暴露 `require` |
| **renderer** | 编辑器与全部 UI | 无 Node 权限、无直接 fs 访问 |
| **utility** | 全文搜索、大文件解析、导出渲染等 CPU 密集任务 | 无窗口 |

窗口配置固定为：

```ts
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: path.join(__dirname, 'preload.js'),
  },
})
```

这三个开关是安全底线，任何 PR 想改都必须走 ADR。

## 4. HostBridge：内核与壳的唯一接缝

内核对宿主能力的全部需求收敛成一个接口。Electron 版用 IPC 实现，Web 版用
File System Access API 实现，测试用内存实现。

```ts
// @mosu/plugin-api/src/host.ts
export interface HostBridge {
  fs: {
    read(path: string): Promise<{ text: string; encoding: Encoding; eol: Eol; mtimeMs: number }>
    write(path: string, text: string, opts: WriteOptions): Promise<{ mtimeMs: number }>
    list(dir: string): Promise<DirEntry[]>
    watch(dir: string, cb: (ev: FsEvent) => void): Disposable
    /** 把工作区内的相对路径解析为渲染进程可加载的 URL（见 §6） */
    resolveAssetUrl(path: string): string
  }
  dialog: {
    openFile(opts?: OpenOptions): Promise<string[] | null>
    saveFile(opts?: SaveOptions): Promise<string | null>
    confirm(msg: ConfirmOptions): Promise<boolean>
  }
  shell: {
    openExternal(url: string): Promise<void>
    revealInFolder(path: string): Promise<void>
  }
  clipboard: {
    readImage(): Promise<Uint8Array | null>
  }
  settings: KeyValueStore
  platform: { os: 'mac' | 'win' | 'linux'; locale: string }
}
```

**收益**：编辑器全部逻辑可以在 Node 里用内存 HostBridge 单测，不需要起 Electron。
端到端测试只覆盖真正需要真实文件系统的路径。

## 4.1 多窗口与标签页

M1 实现的是单窗口单文档（`mainWindow` 是模块级单例）。多窗口与标签页的完整模型
见 [ADR-0005](../adr/0005-windows-and-tabs.md) —— **两者都已落地**：窗口装载、
标签持有状态，每个标签有独立的撤销栈与脏标记，会话可恢复。
这里只记对**进程模型**的三条硬性影响：

**1. main 侧不能再有窗口单例。** 用一个窗口注册表持有全部窗口及其状态，
所有「当前窗口」的语义一律解析为 `BrowserWindow.getFocusedWindow()`。

**2. IPC 消息必须能反查发送方窗口。** 这是 M1 遗留的实打实的缺陷：
`respond-close` 通道没有任何窗口标识，直接操作 `mainWindow`。两个窗口同时
询问「要不要保存」时，回复会串台、关错窗口。修法是所有 renderer → main 的
消息都用 `event.sender` 反查 `BrowserWindow.fromWebContents()`。

**3. 进程级的东西保持进程级。** 路径白名单、设置、协议处理器都不随窗口分裂 ——
它们本来就是进程范围的资源。`applyContentSecurityPolicy()` 目前每次
`createWindow()` 都调一遍（靠 `onHeadersReceived` 只保留最后一个监听器
才没出问题），多窗口下应当挪到 app ready 时只注册一次。

## 5. IPC 约定

- 所有 IPC 通道名集中在 `apps/desktop/src/shared/channels.ts`，双端共用同一份类型。
- 一律 `invoke/handle`（请求-响应），事件推送单独用带前缀的 `send`。
- **凡是会改变某个窗口状态的消息，都必须能确定是哪个窗口**（见 §4.1 第 2 条）。
- **main 侧不信任 renderer 传来的任何路径**：每个文件操作都要经过
  `assertAllowed(path)`（读写）或 `assertAllowedDirectory(path)`（列目录）——
  规范化、解析符号链接、再校验是否位于当前工作区或用户显式选择过的文件白名单内。
  这是防「渲染进程被 XSS 后读走 `~/.ssh`」的关键一环。

### 5.1 校验严不严不重要，**谁能授权**才重要

上面那条只说了一半。`path-guard.ts` 里有两类函数：

| | 函数 | 作用 |
|---|---|---|
| **校验** | `assertAllowed` / `assertAllowedDirectory` | 拒绝白名单外的路径 |
| **授权** | `grantFile` / `grantDirectory` | 把路径**加进**白名单 |

校验函数写得再严，只要授权函数能被渲染进程间接触发，整堵墙就是纸的 ——
这正是 issue #4 的形态。`window:create` 的处理器里当时有一句
`await grantFile(target)`，而 `target` 完全由渲染进程给。喂一个
`~/.ssh/id_rsa` 进去，`~/.ssh` 整个目录就进了 `allowedDirs`，读写全开。
放大它的两点：`grantFile` 会连**所在目录**一起授权（相对路径图片要用），
而且**目标文件根本不需要存在**（`realpath` 失败被 catch 掉，dirname 照样入表），
所以攻击方连「先猜中一个真实文件名」都不必。

修的时候还发现同一条通道上有**两处**授权：IPC 处理器一处、`createWindow`
内部一处。只删前者等于没修 —— 这也是为什么规矩要定成一条能机械检查的边界，
而不是「小心点用」：

> **`grantFile` / `grantDirectory` 只能在 `main/index.ts` 里调用。**

理由是那里是进程入口，对话框结果、命令行参数、`open-file` 事件、会话恢复
全在它手上，每一处都能当场判断路径究竟是不是用户选的。别的模块拿不到这个
上下文，就不该有这个能力。`path-guard.test.ts` 里的「授权原语的调用面」
按文件扫描把这条钉死了。

同源的还有 issue #7：`dialog:save` 在授权用户选中的文件之后，顺手
`grantDirectory(dirname(filePath))`。`grantDirectory` 写的是 `workspaceRoots`，
而它是**递归**的 —— 于是「另存为到 ~/Documents」把整个 ~/Documents 的
**目录枚举**权也交了出去。授权时要问的不只是「这个路径是不是用户选的」，
还有「用户选它的时候，同意的是哪一种权限」。

### 5.2 contextBridge 是**按值拷贝**的

暴露出去之后再改 preload 这一侧的原对象，渲染进程**一无所知**。

这条踩过一次，而且潜伏了很久。preload 里原来是这么写的：

```ts
const api = { platform: { os: 'linux', locale: 'zh-CN' } }   // 先给个默认值
void invoke(CHANNELS.platformInfo).then((info) => {
  api.platform.os = info.os                                   // 再异步写回
})
contextBridge.exposeInMainWorld('mosu', api)
```

那次写回根本传不过去，于是**渲染进程读到的 `platform.os` 永远是 `'linux'`**。

后果不只是「macOS 上快捷键提示按 Windows 的样子显示」（这条一直存在，
没人测过），还包括快捷键录制去看 `ctrlKey` 而不是 `metaKey` —— macOS 上按
⌘⇧B 录出来是 `Shift+B`。**Linux 上「默认值恰好是对的」，所以它躲了很久**，
直到新加的端到端用例在 macOS CI 上把它撞出来。

规矩：**preload 要暴露的值必须在 `exposeInMainWorld` 之前就是终值。**
需要向 main 取的，走 `ipcRenderer.sendSync`（preload 在页面脚本之前执行，
一次同步 IPC 的代价可以忽略），别用「先占位、后回填」。

推论：这类缺陷**在单平台上测不出来**，因为占位值总有一天恰好是对的。
凡是「按平台取值」的东西，都该有一条**在本平台恒绿、专门守其他平台**的断言
（`e2e/keybindings.spec.ts` 里那条就是）。

## 6. 安全模型

Markdown 编辑器的特殊风险：文档内容来自外部（别人发来的 `.md`），而 Electron 渲染
进程一旦被 XSS，配合宽松的 preload 就等于任意代码执行。因此：

| 面 | 措施 |
| --- | --- |
| 原始 HTML | Markdown 内嵌 HTML 渲染前经 DOMPurify 消毒；默认剥离 `<script>`、事件属性、`javascript:`；用户可在设置里选择「完全不渲染原始 HTML，按代码显示」 |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src mosu-asset: data: blob:; connect-src 'self'` —— 注意**不允许远程图片默认加载**，避免文档变成追踪信标；用户可对当前文档一次性放行 |
| 本地资源 | 注册自定义协议 `mosu-asset://`，处理器把 URL 映射回真实路径并校验必须位于工作区内；不使用 `file://` |
| 外链 | `setWindowOpenHandler` 一律 deny 并转交系统浏览器；点击链接前对非 `http(s)`/`mailto` 协议弹确认 |
| 图表渲染 | Mermaid 等渲染出的 SVG 同样经消毒；渲染在 Worker/隔离上下文中进行，避免第三方库直接接触 DOM |
| 插件 | 见 [ADR-0004](../adr/0004-plugin-isolation.md)：清单声明权限，敏感能力经 main 代理并二次校验 |
| 更新 | 更新包必须签名校验；不做静默安装 |

**诚实说明**：只要插件跑在渲染进程里，它与编辑器就共享同一个 JS 上下文，"权限模型"
挡的是**误用**而不是**恶意**。真正的隔离需要把插件放进独立的 utility 进程 / Worker，
只允许 RPC。ADR-0004 记录了这个取舍与演进路径。

## 7. 状态管理

- **文档状态**（内容、选区、撤销栈）：由 CodeMirror 的 `EditorState` 持有，不外置。
  这是唯一真相，任何 UI 都不允许缓存文档内容的副本。
- **应用状态**（打开的标签页、侧边栏、工作区、设置）：一个轻量 store（Zustand 量级即可），
  纯数据、可序列化，用于会话恢复。
- **派生状态**（大纲、字数、单词计数）：从 `EditorState` 派生，用 CodeMirror 的
  `StateField` 或选择器计算，不单独存。

规则：**任何能从文档文本推导出来的东西，都不进 store。**

## 8. 技术选型清单

| 领域 | 选择 | 理由 |
| --- | --- | --- |
| 语言 | TypeScript（strict） | — |
| 包管理 | pnpm workspace | 硬链接、依赖隔离严格 |
| 构建 | Vite（renderer）+ tsup/esbuild（库与 main） | 快，配置少 |
| 桌面壳 | Electron | [ADR-0001](../adr/0001-desktop-shell.md) |
| 编辑器 | CodeMirror 6 | [ADR-0002](../adr/0002-editor-core.md) |
| 解析 | @lezer/markdown（编辑）+ remark/mdast（语义） | [ADR-0003](../adr/0003-dual-parser.md) |
| UI 框架 | React | 生态与可招募性；UI 层薄，替换成本可控 |
| 样式 | CSS 变量 + 原生 CSS Modules | 主题必须能被用户手写 CSS 覆盖，不用 CSS-in-JS |
| 数学 | KaTeX | 快、无需网络、体积可控 |
| 图表 | Mermaid（可插拔） | 按需懒加载，不进主 bundle |
| 测试 | Vitest + Playwright | — |
