/**
 * 设置存储。
 *
 * 就是应用数据目录下的一个 JSON 文件 —— 不引数据库。用户能直接看、直接改、
 * 直接删（原则：本地优先，不锁定用户数据）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

let cache: Record<string, unknown> | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

async function load(): Promise<Record<string, unknown>> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(settingsPath(), 'utf8')) as Record<string, unknown>
  } catch {
    // 文件不存在或已损坏：用空配置继续，绝不因为设置文件坏了就打不开编辑器
    cache = {}
  }
  return cache
}

export async function getSetting(key: string): Promise<unknown> {
  return (await load())[key]
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const data = await load()
  data[key] = value

  const target = settingsPath()
  await mkdir(path.dirname(target), { recursive: true })
  // 同样走原子写：设置文件损坏虽然不致命，但没必要留这个坑
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, target)
}
