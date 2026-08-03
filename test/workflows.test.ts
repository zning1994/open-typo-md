/**
 * 工作流之间的约定。
 *
 * `ci.yml` 与 `docs.yml` 的触发路径必须是**互补**的：前者 `paths-ignore` 掉的，
 * 后者必须用 `paths` 接住。原因是仓库里没有 pre-commit 钩子，`pnpm format:check`
 * 只有 CI 这一道 —— 哪条路径两边都不跑，那条路径的格式就没人管了，而它的报应是
 * 下一次改代码时 CI 莫名其妙地红，且跟那次改动无关。
 *
 * 这本来是一句写在两个文件注释里的「改一边记得改另一边」。这个仓库今天已经
 * 因为「靠记性的约定」栽过好几次，所以把它变成检查。
 *
 * **不引 YAML 解析器**：js-yaml 只是某个包的传递依赖，直接 import 是在用幽灵
 * 依赖；为一条断言加一个直接依赖又太重。这里验的本来就是文本约定，
 * 所以用一个够小的提取器 —— 它坏掉时的表现是「列表为空」，而下面第一条断言
 * 就是「不许为空」，不会悄悄变成永远通过。
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url)

const read = (name: string) => readFile(new URL(name, WORKFLOWS), 'utf8')

/**
 * 取出某个 `paths:` / `paths-ignore:` 键下面那串 `- '…'`。
 *
 * 返回每一处出现的列表（push 一处、pull_request 一处），顺序保留 ——
 * 顺序不同也算不一致，因为那说明两边是分别编辑的。
 */
function pathLists(source: string, key: 'paths' | 'paths-ignore'): string[][] {
  const lists: string[][] = []
  const lines = source.split('\n')

  for (const [index, line] of lines.entries()) {
    if (line.trim() !== `${key}:`) continue
    const items: string[] = []
    for (const next of lines.slice(index + 1)) {
      const item = /^\s+- '(.+)'$/.exec(next)
      if (!item?.[1]) break
      items.push(item[1])
    }
    lists.push(items)
  }
  return lists
}

describe('ci.yml 与 docs.yml 的触发路径', () => {
  it('两个文件里各自的 push / pull_request 清单先要自洽', async () => {
    const [ci, docs] = await Promise.all([read('ci.yml'), read('docs.yml')])

    const ignored = pathLists(ci, 'paths-ignore')
    const covered = pathLists(docs, 'paths')

    // 提取器坏掉的话，下面的相等断言会因为「两边都是空」而通过 ——
    // 所以先把「非空」钉死
    expect(ignored.length).toBe(2)
    expect(covered.length).toBe(2)
    for (const list of [...ignored, ...covered]) expect(list.length).toBeGreaterThan(3)

    // GitHub Actions 不支持 YAML 锚点，所以同一份清单在每个文件里写了两遍
    expect(ignored[0]).toEqual(ignored[1])
    expect(covered[0]).toEqual(covered[1])
  })

  it('互补：ci.yml 摘出去的，docs.yml 全都接住', async () => {
    const [ci, docs] = await Promise.all([read('ci.yml'), read('docs.yml')])
    expect(pathLists(docs, 'paths')[0]).toEqual(pathLists(ci, 'paths-ignore')[0])
  })

  it('改 ci.yml 自己必须触发 ci.yml —— 它不能在被摘掉的清单里', async () => {
    expect(pathLists(await read('ci.yml'), 'paths-ignore')[0]).not.toContain(
      '.github/workflows/ci.yml',
    )
  })
})
