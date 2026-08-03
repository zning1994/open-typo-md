# 给 Claude 的项目须知

Mosu：开源的 Markdown 所见即所得编辑器（Electron + CodeMirror 6）。

**这份文件只写「不看会踩坑」的东西。** 完整的设计与取舍在 `docs/design/`（中文，
九篇 + 五份 ADR），不要在这里重复它们 —— 每个会话都要读一遍这个文件，它越短越好。

## 三条不可破的规则

破了哪一条都是正确性 bug，不是风格问题。

1. **文件即真相。** CodeMirror 的缓冲区里存的就是磁盘上那份 Markdown。渲染是
   基于装饰的投影，没有中间私有模型。「打开 → 保存后字节不变」是硬约束。
2. **绝不吞内容。** 解析不了的东西按源码显示，不能丢。
3. **编辑器内核不认识 Node 和 Electron。** `packages/editor` 及其以下必须能在
   纯浏览器里跑。`pnpm layers` 在 CI 里强制依赖方向。

## 常用命令

```bash
pnpm verify                    # CI 那套：layers + 类型 + lint + 格式 + 单测
pnpm test                      # 只跑单测（含 CommonMark 全量语料）
xvfb-run -a pnpm test:e2e      # 端到端 221 条，约 4.5 分钟（Linux 需要虚拟显示）
pnpm build                     # main / preload / renderer
```

改代码之后 `pnpm verify` 是最低要求。**碰装饰规则、Markdown 编解码、
`packages/markdown` 的，必须说清对格式保真的影响。**

## 测试的规矩

- **一个不会失败的测试比没有测试更糟** —— 它还占着「这里已经测过了」的位置。
  新加的测试要**亲自验证它对着旧代码是红的**，改完再绿。
- **只在一个平台上跑的测试，失败方式是假阳性。** 单测的 `check` job 只跑 Linux；
  碰真实文件系统的用例在 macOS / Windows 上可能**恒绿而且验错了东西**。已经踩过
  三次，详见 `docs/design/07-quality.md` §1。本地复现 macOS 的符号链接行为：

  ```bash
  mkdir -p /tmp/realtmp && ln -sfn /tmp/realtmp /tmp/linktmp
  TMPDIR=/tmp/linktmp pnpm vitest run apps/desktop/test/path-guard.test.ts
  ```

- 路径守卫的测试里，**每个被拒绝的目标都必须真实存在** —— 否则守卫走的是
  「路径不可访问」那条分支，白名单整个失效也照样绿。

## CI 分两条道

| 改了什么 | 跑什么 | 多久 |
| --- | --- | --- |
| 代码、`ci.yml` | CI（三平台 e2e + 打包） | ~10 分钟 |
| `docs/**`、`*.md`、其它 workflow、issue 模板、`dependabot.yml` | Docs（格式 + 建站） | ~1 分钟 |

两份路径清单**必须互补**，由 `test/workflows.test.ts` 钉着。原因：仓库里**没有
pre-commit 钩子**，`pnpm format:check` 只有 CI 这一道；哪条路径两边都不跑，格式就
没人管了。GitHub Actions **不支持 YAML 锚点**，所以清单在每个文件里写两遍。

## 发布

推一个 `v*` tag 就够了，其余自动：三平台并行打包 → 全绿后建**草稿** Release。

- 正文放 `release-notes/<tag>.md`（可选），后面自动接上按 Conventional Commits
  生成的变更清单。两段都可以缺席。
- macOS 已配 Developer ID 签名 + 公证，五个 secret 在仓库设置里。
- Windows **刻意不签名**，理由见 `docs/design/07-quality.md` §6.2 —— 不要「顺手修一下」。
- 第一次真发布连挂四轮，七个洞记在 §6.7，值得读一遍再动这条流水线。

## 这个执行环境的坑

- **git 中继只放行往分支推提交。** 推 tag、删远端分支都会 403，重试无用 ——
  那两件事得让用户在网页上做。
- **出站代理挡掉绝大多数外部站点**（`docs.github.com`、shields.io 都不通）。
  但 `github.com` 的 git 操作可以，所以想读某个 action 的 `action.yml`，
  用 `git clone --depth 1 --branch <tag>` 而不是 curl。
- **没有 `gh` CLI**，GitHub 操作走 MCP 工具（`mcp__github__*`）。
- MCP 的仓库名要用 **`open-typo-md`**（旧名），新名 `mosu` 会被拒；GitHub 那边
  透明重定向。

## 依赖

- **Dependabot 的 npm 版本更新是关掉的。** 它在这个仓库生成不出可用的 pnpm
  lockfile（只改 `package.json`，CI 12 秒挂在 `ERR_PNPM_OUTDATED_LOCKFILE`）。
  依赖升级由人发起：改 manifest → 本地 `pnpm install` → 完整 CI → 打包冒烟。
  漏洞通知不受影响，Dependabot alerts 照常。
- GitHub Actions 的更新还开着，但**别照单全收**：规矩是「已经是 node24 就不为
  追新而升」。action 的运行时**看版本号看不出来**（`upload-artifact@v5` 仍是
  node20），要 clone 下来读 `action.yml` 的 `runs.using`，表在 `ci.yml` 顶部。

## 提交

Conventional Commits。**提交信息是这个项目的主要记忆载体** —— 写清楚为什么这么改、
试过哪些不成立的做法、以及下一个人会怎么踩回去。这不是仪式，是因为会话不跨容器，
而仓库跨。
