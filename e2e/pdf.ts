/**
 * 读 PDF 产物用的小工具。
 *
 * ## 为什么按 `/Length` 切流，而不是找 `endstream`
 *
 * 找 `endstream` 是个陷阱：流里装的是 **Flate 压缩后的二进制**，
 * 它完全可能恰好包含 `endstream` 这几个字节。撞上了就会把流截断，
 * 解压失败，而失败又是被 `catch` 静默吞掉的 —— 于是产物看起来「没有内容」。
 *
 * 这个坑真的踩过：macOS 上 PDF 导出被误判成「产出空白页」，追了两轮 CI，
 * 最后发现 PDF 本身是好的，是这里切错了。字体子集的字节因平台而异，
 * 所以它表现为「只在 macOS 上复现」，看着特别像产品的平台缺陷。
 *
 * 正确做法是信流字典里的 `/Length` —— 那是 PDF 规范给出的长度。
 */
import { inflateSync } from 'node:zlib'

/** 从 `stream` 关键字往前找它自己那个字典里的 `/Length`。 */
const LENGTH_NEAR = /\/Length\s+(\d+)/g

function lengthBefore(raw: string, streamAt: number): number | null {
  // 字典就紧贴在 stream 前面，往回看几百字节足够，再多会串到上一个对象
  const from = Math.max(0, streamAt - 400)
  const window = raw.slice(from, streamAt)
  let found: number | null = null
  LENGTH_NEAR.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LENGTH_NEAR.exec(window))) found = Number(match[1])
  return found
}

/** 解开 PDF 里所有 Flate 流，拼成一段可搜索的文本。 */
export function contentStreams(buf: Buffer): string {
  const raw = buf.toString('latin1')
  const out: string[] = []
  const marker = /stream\r?\n/g
  let match: RegExpExecArray | null

  while ((match = marker.exec(raw))) {
    const start = match.index + match[0].length
    const length = lengthBefore(raw, match.index)
    // 没有 /Length 的流不该存在（PDF 规范要求），出现了就跳过，不猜
    if (length === null) continue
    try {
      out.push(
        inflateSync(Buffer.from(raw.slice(start, start + length), 'latin1')).toString('latin1'),
      )
    } catch {
      // 非 Flate 流（图片可能用别的滤镜），跳过
    }
  }
  return out.join('\n')
}

/** 文档页数。 */
export function pageCount(buf: Buffer): number {
  const counts = buf.toString('latin1').match(/\/Count\s+(\d+)/g) ?? []
  return Math.max(0, ...counts.map((c) => Number(c.replace(/\D/g, ''))))
}

/** 页面背景那句填充矩形的宽高 —— 能看出纸张方向。 */
export function backgroundRect(buf: Buffer): [number, number] {
  const rect = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) re$/m.exec(
    contentStreams(buf),
  )
  if (!rect) throw new Error('PDF 里找不到背景矩形')
  return [Number(rect[3]), Number(rect[4])]
}
