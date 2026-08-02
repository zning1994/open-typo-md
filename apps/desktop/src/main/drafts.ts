/**
 * 崩溃恢复的草稿（docs/design/04 §4）。
 *
 * 用户输入后防抖把未保存内容写进应用数据目录（**不是工作区** —— 草稿是我们的
 * 私事，不该出现在用户的 git status 里）：
 *
 * ```
 * <userData>/drafts/<hash(path)>/
 * ├── meta.json      # 原文件路径、基线 hash、时间戳
 * └── content.md     # 当前缓冲区内容
 * ```
 *
 * ## 两条纪律
 *
 * **写失败只记日志，绝不打断用户输入。** 草稿是保险，不是主线；
 * 磁盘满了、目录没权限的时候，最不该做的事就是弹个框把人从写作里拽出来。
 *
 * **正常保存后立刻删掉对应草稿。** 留着的话下次启动会提示恢复一份和磁盘
 * 一模一样的内容 —— 用户会以为自己丢过东西，比不提示更糟。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

export interface DraftMeta {
  /** 原文件绝对路径；未命名文档为 null。 */
  path: string | null
  /** 写草稿时编辑器持有的磁盘基线 hash。 */
  baselineHash: string | null
  savedAt: number
}

export interface Draft extends DraftMeta {
  /** 草稿目录的 key，恢复/丢弃时用它定位。 */
  id: string
  text: string
}

function draftsRoot(): string {
  return path.join(app.getPath('userData'), 'drafts')
}

/**
 * 草稿目录名。
 *
 * 用路径的 hash 而不是路径本身：文件路径里的 `/`、中文、超长名字直接做目录名
 * 会在三个平台上各出各的问题。未命名文档没有路径，用窗口维度的 key 兜住 ——
 * 由调用方传入，保证同一个窗口反复写的是同一份草稿而不是每次一个新目录。
 */
function draftId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 24)
}

export async function writeDraft(key: string, text: string, meta: DraftMeta): Promise<void> {
  try {
    const dir = path.join(draftsRoot(), draftId(key))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'content.md'), text, 'utf8')
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
  } catch (error) {
    // 见文件头：草稿是保险，不是主线
    console.warn('[mosu] 草稿写入失败：', error)
  }
}

export async function dropDraft(key: string): Promise<void> {
  try {
    await rm(path.join(draftsRoot(), draftId(key)), { recursive: true, force: true })
  } catch (error) {
    console.warn('[mosu] 草稿清理失败：', error)
  }
}

let claimed = false

/**
 * 认领草稿 —— 整个应用生命周期里只成功一次。
 *
 * 恢复提示只该出现一次，而多窗口下每个渲染进程启动时都会各问一遍。
 * 把「只有一次」做进这里，比让每个渲染进程自己想办法协调可靠得多。
 */
export async function claimDrafts(): Promise<Draft[]> {
  if (claimed) return []
  claimed = true
  return listDrafts()
}

/**
 * 列出所有草稿。
 *
 * **内容与原文件一致的草稿会被自动丢弃** —— 那说明上次是正常保存后退出的
 * （或者保存成功但删草稿失败），没什么可恢复的。这一步顺带把目录清干净。
 */
export async function listDrafts(): Promise<Draft[]> {
  let ids: string[]
  try {
    ids = await readdir(draftsRoot())
  } catch {
    return [] // 目录还不存在 —— 从来没崩过，很好
  }

  const found: Draft[] = []
  for (const id of ids) {
    const dir = path.join(draftsRoot(), id)
    try {
      const [text, rawMeta] = await Promise.all([
        readFile(path.join(dir, 'content.md'), 'utf8'),
        readFile(path.join(dir, 'meta.json'), 'utf8'),
      ])
      const meta = JSON.parse(rawMeta) as DraftMeta

      if (meta.path && (await sameAsDisk(meta.path, text))) {
        await rm(dir, { recursive: true, force: true })
        continue
      }
      // 未命名文档的空草稿同样没有恢复价值
      if (!meta.path && text.trim() === '') {
        await rm(dir, { recursive: true, force: true })
        continue
      }

      // `baselineHash` 是后加的字段，旧版本写的草稿里没有这个键，而上面那个
      // `as DraftMeta` 是不检查的断言 —— 归一一下，让吐出去的对象真的符合类型。
      // （恢复那侧的默认参数也接得住 undefined，这里是让边界干净。）
      found.push({ id, text, ...meta, baselineHash: meta.baselineHash ?? null })
    } catch {
      // 半截的草稿目录（写到一半崩了）：丢掉，别让它卡住整个恢复流程
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return found.sort((a, b) => b.savedAt - a.savedAt)
}

async function sameAsDisk(target: string, text: string): Promise<boolean> {
  try {
    return (await readFile(target, 'utf8')) === text
  } catch {
    return false // 原文件没了 —— 草稿反而更该留着
  }
}

export async function dropDraftById(id: string): Promise<void> {
  try {
    await rm(path.join(draftsRoot(), id), { recursive: true, force: true })
  } catch (error) {
    console.warn('[mosu] 草稿清理失败：', error)
  }
}
