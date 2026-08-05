/**
 * 把一份 Patch 从「生成它时的文档」映射到「现在的文档」（设计 10 §3.2）。
 *
 * ## 这一层在防什么
 *
 * 模型吐字要几秒，diff 摆在那儿等用户看又要几秒。这期间用户完全可能在别处继续
 * 打字 —— 而 `from` / `to` 是**偏移量**，文档一变它们就指向别的地方。
 *
 * 不处理的后果不是报错，是**静默改错位置**：AI 把用户刚打的字覆盖掉。
 *
 * 所以规则是三条，第三条最要紧：
 *
 * 1. 基线版本就是当前版本 —— 原样应用；
 * 2. 中间有改动，但都没碰到 AI 要改的那几段 —— 映射过去；
 * 3. **碰到了就拒绝**。不猜。「大概是这个位置吧」在这个场景下的失败是丢用户的字。
 *
 * ## 为什么不直接用 CodeMirror 的 `touchesRange`
 *
 * 试过，太严：`touchesRange` 在**边界相邻**时也返回 true。实测（doc 长 10）：
 *
 * - 用户在 5 处插入，问 `touchesRange(0, 5)` → `true`；
 * - 用户删掉 `[2, 6)`，问 `touchesRange(0, 2)` → `true`、`touchesRange(6, 8)` → `true`。
 *
 * 也就是说「AI 改写一句话，用户紧接着在它后面继续打字」会被判成冲突。那是这个
 * 功能最常见的用法，按相邻拒绝等于让它基本不可用。
 *
 * 这里改用**严格重叠**：`change.fromA < edit.to && change.toA > edit.from`。
 * 纯插入（`from === to`）代进同一个式子就是「插入点落在某段被删掉的文本内部」，
 * 不需要第二条规则。
 *
 * ## 为什么这个包里自己算，而不是 import CodeMirror
 *
 * `@mosu/agent-core` 是**零运行时依赖**的叶子：main 进程要用它的 Tool Registry
 * 与 Patch 校验，不该为此把 CodeMirror 拖进 main。所以这里只认一个平铺的
 * `ChangedRange[]`——渲染进程用 `changedRangesFrom` 把 `ChangeDesc` 转过来，
 * 一行。
 *
 * **这不是「自己写一遍位置映射」的借口**：`test/apply.test.ts` 里的用例全部用
 * 真的 `ChangeSet` 造改动，并逐点跟 CodeMirror 自己的 `mapPos` 对答案。替身顶在
 * 系统边界上，不顶在自己的代码上（07 §1）。
 */
import type { Patch, PatchEdit } from './patch.js'

/**
 * 旧文档 → 新文档的一段改动。
 *
 * `fromA` / `toA` 是**旧**文档里的位置，`fromB` / `toB` 是**新**文档里的。
 * 与 CodeMirror `ChangeDesc.iterChangedRanges` 的回调参数一一对应。
 */
export interface ChangedRange {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

export interface DocumentSnapshot {
  version: number
  length: number
}

export interface MapPatchInput {
  patch: Patch
  /** 现在的文档 */
  current: DocumentSnapshot
  /**
   * 从 `patch.baseVersion` 那一刻到 `current` 之间的全部改动。顺序不重要。
   *
   * `null` 表示**拿不到**（标签被关过、会话恢复过、版本对不上但没有记录）。
   * 那种情况一律拒绝 —— 不知道中间发生了什么，就不能假设什么都没发生。
   */
  changes: readonly ChangedRange[] | null
}

export type MappedPatch =
  /** 文档没变，原样应用 */
  | { status: 'clean'; patch: Patch }
  /** 文档变了，但 AI 要改的那几段没被碰过，位置已经挪好 */
  | { status: 'mapped'; patch: Patch }
  /** 用户改到了 AI 要改的那一段。`conflicts` 是 `patch.edits` 里的下标 */
  | { status: 'stale'; conflicts: number[] }
  /** 中间发生了什么无从得知 */
  | { status: 'unknown-baseline' }

/**
 * 把 CodeMirror 的 `ChangeDesc` 摊成 `ChangedRange[]`。
 *
 * 写成「接一个迭代函数」而不是「接一个 ChangeDesc」，是为了让这个包**一行
 * CodeMirror 都不 import**。渲染进程侧的用法：
 *
 * ```ts
 * const ranges = changedRangesFrom((visit) => changes.iterChangedRanges(visit))
 * ```
 */
export function changedRangesFrom(
  iterate: (visit: (fromA: number, toA: number, fromB: number, toB: number) => void) => void,
): ChangedRange[] {
  const ranges: ChangedRange[] = []
  iterate((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }))
  return ranges
}

/** 严格重叠。相邻不算 —— 理由见文件头。 */
function overlaps(change: ChangedRange, edit: PatchEdit): boolean {
  return change.fromA < edit.to && change.toA > edit.from
}

/**
 * 把旧位置映射到新位置：累加**在它之前**的那些改动的长度差。
 *
 * ## 两端的 `assoc` 必须不一样，这条是踩出来的
 *
 * 第一版两端用同一条规则（`toA <= pos`，相当于 CodeMirror 的 `mapPos(pos, 1)`），
 * 结果是：**AI 改写一句话、用户紧接着在它后面打字，应用之后用户打的字没了。**
 *
 * `Hello world` → AI 要把 `[0,5)` 换成 `Goodbye`；用户在 5 处插入 `, dear`。
 * 区间的**末端**若也按「插入点之后」算，`5` 会被映射成 `11`，
 * 于是 AI 的替换范围一路吃掉用户刚打的那六个字。
 *
 * 所以：
 *
 * - **区间的起点**用 `assoc = 1`（贴住后面的文本）——「用户在我前面插的字，
 *   不属于我要替换的范围」；
 * - **区间的末端**用 `assoc = -1`（贴住前面的文本）——「用户在我后面插的字，
 *   同样不属于我」。
 *
 * **纯插入（`from === to`）两端必须用同一个 assoc**，否则会算出 `from > to`
 * 这种不可能的区间。取 `1`：读起来是「用户先打了字，AI 的内容接在后面」，
 * 而插入点本来就不删字，选哪一侧都不会覆盖任何东西。
 */
function mapPosition(pos: number, changes: readonly ChangedRange[], assoc: 1 | -1): number {
  let delta = 0
  for (const change of changes) {
    // 用判断而不是「排好序之后 break」：那样一来顺序就成了隐含前提，
    // 而传错顺序的失败是「位置算错了但没人报错」。
    if (change.toA > pos) continue
    // assoc = -1：恰好落在 pos 上的**纯插入**不算在「之前」
    if (assoc === -1 && change.fromA >= pos) continue
    delta += change.toB - change.fromB - (change.toA - change.fromA)
  }
  return pos + delta
}

/**
 * 前提：`patch` 已经过 `validatePatch()`（升序、不重叠、在旧文档范围内）。
 * 这里不重复校验 —— 重复的校验迟早会跟原版分家，而分家之后没人知道该信哪个。
 */
export function mapPatch({ patch, current, changes }: MapPatchInput): MappedPatch {
  if (patch.baseVersion === current.version) {
    return { status: 'clean', patch }
  }
  if (changes === null) {
    return { status: 'unknown-baseline' }
  }

  const conflicts: number[] = []
  for (let i = 0; i < patch.edits.length; i++) {
    const edit = patch.edits[i]!
    if (changes.some((change) => overlaps(change, edit))) conflicts.push(i)
  }
  if (conflicts.length > 0) {
    return { status: 'stale', conflicts }
  }

  const edits = patch.edits.map((edit) => {
    const from = mapPosition(edit.from, changes, 1)
    return {
      from,
      to: edit.from === edit.to ? from : mapPosition(edit.to, changes, -1),
      insert: edit.insert,
    }
  })

  // 兜底：映射本身是单调的，理论上不会越界。但这一层的失败模式是「悄悄改错
  // 位置」，所以宁可在这里多问一句 —— 越界了就当成拿不到基线，让用户重新生成。
  const last = edits[edits.length - 1]
  if (last && (last.to > current.length || edits[0]!.from < 0)) {
    return { status: 'unknown-baseline' }
  }

  return {
    status: 'mapped',
    patch: { ...patch, baseVersion: current.version, edits },
  }
}
