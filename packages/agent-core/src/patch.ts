/**
 * Patch：AI 唯一能改文档的形式（设计 10 §3、ADR-0006 不变量 1）。
 *
 * ## 为什么不是「整篇新文档」
 *
 * 这是这一层唯一一处**违反了就是正确性 bug** 的地方。G2 要求「局部编辑只产生
 * 局部 diff：改一个词不会重排整个文档的缩进 / 引号 / 换行风格」，而模型重写整篇
 * 的产物必然是**它自己的**格式偏好 —— 无序列表的 `-` 变成 `*`、换行位置全变、
 * 行尾空格消失。用户按下的是「改一个句子」，拿到的是一份 diff 全红的文件。
 *
 * 所以 Patch 的单位是**基于位置的替换**。
 *
 * ## 为什么校验不抛异常
 *
 * 这里的输入是模型的输出，**失败是常态而不是意外**。抛异常意味着每个调用点都要
 * try/catch，而漏掉一个就是一次崩溃；返回问题清单则逼着调用方处理它。
 */

/** 一处替换。`from === to` 是纯插入。半开区间 `[from, to)`。 */
export interface PatchEdit {
  from: number
  to: number
  insert: string
}

export interface Patch {
  /**
   * 生成这份 Patch 时文档的版本号。
   *
   * 没有它就没法判断「从生成到应用之间文档变没变」，而那正是这一层最危险的
   * 失败模式（见 apply.ts）。所以它是必填的，不给默认值 —— 默认值会让
   * 「忘了带版本」看起来像「文档没变」。
   */
  baseVersion: number
  edits: PatchEdit[]
  /** 给用户看的一句话。不参与应用，也不参与校验。 */
  summary: string
}

export type PatchProblem =
  /** 一条 edit 都没有。模型说它改了什么，但没给出改动 */
  | { kind: 'empty' }
  /** `from > to` */
  | { kind: 'reversed'; index: number }
  /** 落在文档之外 */
  | { kind: 'out-of-range'; index: number; docLength: number }
  /** 前一条的 `from` 比后一条大 —— 没有按位置升序排 */
  | { kind: 'unsorted'; index: number }
  /** 与前一条重叠 */
  | { kind: 'overlap'; index: number }
  /** 删空补空，什么都没改 */
  | { kind: 'no-op'; index: number }

/**
 * 校验一份 Patch 能不能安全地应用到长度为 `docLength` 的文档上。
 *
 * 返回空数组表示可以。**问题会全部列出来，不在第一条就返回** —— 模型一次犯三个
 * 错是常事，一条一条地退回去改要跑三轮。
 *
 * ## 三条刻意的严格
 *
 * - **要求升序且不重叠，不替调用方排序。** 自动排序会把「模型给了两条重叠的
 *   编辑」这种真错误变成一个看起来正常的结果 —— 而那个结果改的位置是错的。
 * - **空编辑（`from === to` 且 `insert === ''`）算错误**，不是无害的噪音。
 *   它要么是模型算错了位置，要么是它以为自己做了什么。放它过去，diff 预览会
 *   显示「3 处改动」而其中只有 2 处是真的。
 * - **不检查 `insert` 的内容。** 规则 2（绝不吞内容）在这里的形态是：我们不替
 *   用户判断模型写的字是不是「合法的 Markdown」。渲染不了的东西按源码显示，
 *   那是编辑器一直以来的行为。
 */
export function validatePatch(patch: Patch, docLength: number): PatchProblem[] {
  const problems: PatchProblem[] = []
  const { edits } = patch

  if (edits.length === 0) {
    problems.push({ kind: 'empty' })
    return problems
  }

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!

    if (edit.from > edit.to) {
      problems.push({ kind: 'reversed', index: i })
      // 区间是反的，后面基于它的比较都没有意义，跳过这一条的其余检查
      continue
    }
    if (edit.from < 0 || edit.to > docLength) {
      problems.push({ kind: 'out-of-range', index: i, docLength })
    }
    if (edit.from === edit.to && edit.insert === '') {
      problems.push({ kind: 'no-op', index: i })
    }

    const previous = edits[i - 1]
    if (previous && previous.from <= previous.to) {
      if (edit.from < previous.from) {
        problems.push({ kind: 'unsorted', index: i })
      } else if (edit.from < previous.to) {
        problems.push({ kind: 'overlap', index: i })
      }
    }
  }

  return problems
}

/**
 * 一份 Patch 净改变了多少个字符。给状态栏 / 预览用。
 *
 * 单独写出来是因为「改了多少」在两处会被算：预览里一处、应用之后的提示一处。
 * 算两遍迟早会不一致。
 */
export function patchDelta(patch: Patch): number {
  let delta = 0
  for (const edit of patch.edits) delta += edit.insert.length - (edit.to - edit.from)
  return delta
}
