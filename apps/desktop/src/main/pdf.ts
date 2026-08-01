/**
 * PDF 导出（docs/design/06 §3）。
 *
 * ## 为什么只有这么点代码
 *
 * PDF 导出当初被列进硬骨头，理由是**分页**：CSS Paged Media 在 Chromium 里
 * 支持不全，页眉页脚、避免表格被切断、目录页码，每一项都要单独跟浏览器的
 * 分页算法搏斗。
 *
 * 那说的是**自己造分页**。HTML 导出一落地，就不必造了 —— 把已经自包含的 HTML
 * 交给 Chromium 打印即可，分页归它管。成本降下来的是范围，不是难度：
 * 页眉页脚、目录页码、精确控制某个块不被切断，这些仍然拿不到（06 §3.2 列清楚了）。
 *
 * ## 这个隐藏窗口的安全设置
 *
 * 装进去的是**用户文档转成的 HTML**。虽然它已经过消毒（`@typo/export` 默认
 * 剥掉 script 与事件属性），这里仍然按「假定它是敌意内容」来配：
 *
 * - `javascript: false` —— 根本不给脚本执行的机会，比依赖上游消毒更硬；
 * - `sandbox` + `contextIsolation`，且不挂任何 preload；
 * - `webSecurity` 保持开启，`allowRunningInsecureContent` 保持关闭。
 *
 * 自包含产物里没有外链（连字体都是 data URI），所以关掉一切网络能力不影响观感。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrowserWindow } from 'electron'

export interface PdfOptions {
  /** 纸张。跟 Electron 的 `pageSize` 一致。 */
  pageSize?: 'A4' | 'A3' | 'Legal' | 'Letter' | 'Tabloid'
  landscape?: boolean
  /** 页边距，英寸。 */
  marginInch?: number
}

/** 页边距默认值，英寸。跟 Word 的默认值接近，打出来不至于顶到纸边。 */
const MARGIN_INCH = 0.6

/**
 * 把一份自包含 HTML 渲染成 PDF 字节。
 *
 * 走临时文件 + `loadFile` 而不是 `data:` URL：整篇文档内联了主题 CSS、
 * KaTeX 字体和图片，`data:` URL 很容易撞上长度上限，
 * 而那个失败是「窗口白屏、没有任何报错」，最难排查的那一类。
 */
export async function renderPdf(html: string, options: PdfOptions = {}): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'typo-pdf-'))
  const file = path.join(dir, 'print.html')
  await writeFile(file, html, 'utf8')

  const win = new BrowserWindow({
    show: false,
    // 给它一个确定的尺寸：任何依赖视口宽度的样式（媒体查询、vw 单位）
    // 都会读到它，而打印产物不该取决于这个窗口碰巧有多大
    width: 1024,
    height: 1440,
    // 隐藏的窗口默认可能根本不绘制，而 printToPDF 打的是绘制结果 ——
    // 不绘制就得到一份只有白底的空白 PDF
    paintWhenInitiallyHidden: true,
    webPreferences: {
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // 后台窗口会被降频甚至暂停，而这个窗口从生到死都在后台
      backgroundThrottling: false,
    },
  })

  try {
    await win.loadFile(file)
    // loadFile 在 did-finish-load 就 resolve 了，那时首帧未必画完
    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) =>
        win.webContents.once('did-stop-loading', () => resolve()),
      )
    }
    return await win.webContents.printToPDF({
      pageSize: options.pageSize ?? 'A4',
      landscape: options.landscape ?? false,
      // 背景必须打出来：代码块底色、引用块的左边线、表格边框都在背景里，
      // 关掉的话导出的 PDF 跟屏幕上完全不是一个东西
      printBackground: true,
      margins: (() => {
        // 设置文件是用户可以直接改的，这里再兜一次底：非数字或超出范围一律
        // 退回默认值。渲染进程那边已经校验过，但 main 不信任传进来的任何东西
        const raw = options.marginInch
        const margin =
          typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 3
            ? raw
            : MARGIN_INCH
        return { top: margin, bottom: margin, left: margin, right: margin }
      })(),
    })
  } finally {
    win.destroy()
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
}
