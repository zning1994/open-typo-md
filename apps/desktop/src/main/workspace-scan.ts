/**
 * 遍历工作区：Quick Open 的文件清单（issue #37）与全工作区搜索（issue #39）。
 *
 * 两件事共用一次遍历的规则，所以放在一个文件里 —— 分开写的结果一定是
 * 「Quick Open 找得到的文件，搜索搜不到」，而这种不一致用户一眼就能看见。
 *
 * ## 为什么在 main 而不在渲染进程
 *
 * 遍历要碰真实文件系统，而渲染进程只有 `fs.list` 这一条通路。在渲染进程里
 * 递归 `list` 意味着几百次 IPC 往返，每一次都要过一遍路径守卫。
 *
 * ## 三条上限，一条都不能少
 *
 * 用户会往「打开文件夹」里丢任何东西 —— home 目录、整个磁盘、一个装着十万份
 * 导出文件的目录。没有上限的话，第一次误操作就是一次几分钟的无响应。
 *
 * 上限触发时**必须说出来**（`truncated`），不能安静地少给几条：
 * 「搜不到」和「没搜完」对用户是完全不同的两件事。
 *
 * ## 不跟随符号链接
 *
 * 跟随的话，工作区里一个指回上级的链接就能让遍历无限转下去。这跟文件树
 * 那一侧（`fs:list` 用 `withFileTypes` 拿链接自身的类型）是同一条规则。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { assertAllowedDirectory } from './path-guard.js'

/** 最多走多深。真实的笔记仓库很少超过五六层。 */
const MAX_DEPTH = 12
/** 最多收多少个文件。 */
const MAX_FILES = 20_000
/** 搜索时单个文件的体积上限 —— 超过它多半不是给人读的。 */
const MAX_SEARCH_BYTES = 4 * 1024 * 1024

/**
 * 不进遍历的东西。跟文件树那一侧保持同一份清单 —— 两处不一致的话，
 * 「树里看不见但搜得到」会让人以为文件重复了。
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', '.DS_Store'])

const MARKDOWN = /\.(md|markdown|mdown|mkd|mdx)$/i

export interface WorkspaceFile {
  path: string
  /** 相对工作区根的 POSIX 路径 —— 界面上显示它，比绝对路径短得多。 */
  relative: string
  name: string
  mtimeMs: number
}

export interface WalkResult {
  files: WorkspaceFile[]
  /** 撞上限了。界面必须把这件事说出来。 */
  truncated: boolean
}

/** 把绝对路径变成相对根的 POSIX 路径（Windows 上也用正斜杠）。 */
function relativeOf(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

/**
 * 收集工作区里的 Markdown 文件。
 *
 * 只收 Markdown：Quick Open 和全文搜索面对的都是「我写的那些文档」。
 * 把图片、PDF、二进制一起收进来，结果列表会被它们淹掉。
 */
export async function walkWorkspace(root: string): Promise<WalkResult> {
  const real = await assertAllowedDirectory(root)
  const files: WorkspaceFile[] = []
  let truncated = false

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return
    if (depth > MAX_DEPTH) {
      truncated = true
      return
    }

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // 读不出来的目录跳过就是了 —— 权限不足、刚被删掉都很正常，
      // 而它不该让整次遍历失败（原则 P2）
      return
    }

    const subdirs: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        subdirs.push(full)
        continue
      }
      if (!entry.isFile() || !MARKDOWN.test(entry.name)) continue

      if (files.length >= MAX_FILES) {
        truncated = true
        return
      }
      const mtimeMs = await stat(full)
        .then((info) => info.mtimeMs)
        .catch(() => 0)
      files.push({ path: full, relative: relativeOf(real, full), name: entry.name, mtimeMs })
    }

    // 先收完本层的文件再下钻：撞上限时留在结果里的是**浅层**的文件，
    // 而浅层几乎总是用户更想找的那些
    for (const sub of subdirs) {
      if (truncated) return
      await visit(sub, depth + 1)
    }
  }

  await visit(real, 0)
  return { files, truncated }
}

export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  /** 只搜这个子目录（相对根）。空表示整个工作区。 */
  scope?: string
}

export interface SearchHit {
  /** 1 起算，跟状态栏和编辑器一致。 */
  line: number
  /** 命中在该行里的起止列（0 起算的字符下标）。 */
  from: number
  to: number
  /** 整行文本，界面上截断显示。 */
  text: string
  /** 该命中在文件里的字符偏移 —— 打开之后直接跳到这里。 */
  offset: number
}

export interface FileMatches {
  path: string
  relative: string
  hits: SearchHit[]
  /** 这个文件里的命中被截断了（单文件命中上限）。 */
  truncated: boolean
}

/** 单个文件里最多报多少条 —— 一份生成的日志能有上万条，报全了没人看。 */
const MAX_HITS_PER_FILE = 100

/**
 * 把查询编成正则。
 *
 * 非正则模式下**必须转义**：用户搜 `a.md` 时那个点是字面点，不是「任意字符」。
 * 少了这一步，搜索结果会莫名其妙地多出一堆看不出为什么命中的行。
 *
 * 正则模式下写坏了（`(` 没闭合是敲到一半的常态）**返回 null 而不是抛**：
 * 边敲边搜时每一次中间状态都是非法的，抛错等于每敲一个字符弹一次错误。
 */
export function compileQuery(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null
  const escaped = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `\b` 在中文边界上没有意义（CJK 不是 \w），所以整词只对含 ASCII 单词字符的
  // 查询有效果。不为此自造一套断言 —— 那会得到一个「有时生效」的开关
  const source = options.wholeWord ? `\\b(?:${escaped})\\b` : escaped
  try {
    return new RegExp(source, options.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
}

/** 在一份文本里找命中。纯函数，可单测。 */
export function findInText(text: string, pattern: RegExp): SearchHit[] {
  const hits: SearchHit[] = []
  const lines = text.split('\n')
  let offset = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    // 每一行都要重置 —— `g` 标志的 lastIndex 会跨行残留，
    // 表现是「后面的行莫名其妙漏掉开头的命中」
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(line)) !== null) {
      hits.push({
        line: i + 1,
        from: match.index,
        to: match.index + match[0].length,
        text: line,
        offset: offset + match.index,
      })
      if (hits.length >= MAX_HITS_PER_FILE) return hits
      // 零宽匹配（`^`、`\b`、`x*`）会让 exec 原地打转。手动推一格
      if (match[0].length === 0) pattern.lastIndex++
    }
    offset += line.length + 1
  }
  return hits
}

/**
 * 搜一个文件。读不出来就当没有命中 —— 二进制、超大、没权限都很正常。
 */
async function searchFile(file: WorkspaceFile, pattern: RegExp): Promise<FileMatches | null> {
  let text: string
  try {
    const info = await stat(file.path)
    if (info.size > MAX_SEARCH_BYTES) return null
    text = await readFile(file.path, 'utf8')
  } catch {
    return null
  }

  const hits = findInText(text, pattern)
  if (hits.length === 0) return null
  return {
    path: file.path,
    relative: file.relative,
    hits,
    truncated: hits.length >= MAX_HITS_PER_FILE,
  }
}

export interface SearchProgress {
  /** 一批结果。分批推是为了让超大工作区能边搜边看。 */
  matches: FileMatches[]
  done: boolean
  /** 遍历撞上限了。 */
  truncated: boolean
}

/** 一批推多少个文件的结果。太小了 IPC 次数爆炸，太大了就不叫渐进了。 */
const BATCH = 20

/**
 * 全工作区搜索，分批把结果交给 `emit`。
 *
 * `shouldStop` 每批问一次：用户改了查询词就该把上一次丢掉。**不检查的话**，
 * 在一个大工作区里连敲五个字符会同时跑五次搜索，而它们的结果会交错着涌进
 * 同一个列表。
 */
export async function searchWorkspace(
  root: string,
  query: string,
  options: SearchOptions,
  emit: (progress: SearchProgress) => void,
  shouldStop: () => boolean,
): Promise<void> {
  const pattern = compileQuery(query, options)
  if (!pattern) {
    emit({ matches: [], done: true, truncated: false })
    return
  }

  const { files, truncated } = await walkWorkspace(root)
  const scoped = options.scope
    ? files.filter((file) => file.relative.startsWith(`${options.scope}/`))
    : files

  let batch: FileMatches[] = []
  for (let i = 0; i < scoped.length; i += BATCH) {
    if (shouldStop()) return
    const slice = scoped.slice(i, i + BATCH)
    const found = await Promise.all(slice.map((file) => searchFile(file, pattern)))
    batch.push(...found.filter((item): item is FileMatches => item !== null))
    if (batch.length > 0) {
      emit({ matches: batch, done: false, truncated: false })
      batch = []
    }
  }

  if (shouldStop()) return
  emit({ matches: [], done: true, truncated })
}
