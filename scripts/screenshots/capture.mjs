/**
 * 自动截图：把真应用跑起来，拍几张给官网和 README 用的图。
 *
 * ## 为什么不手工截
 *
 * 手工截的图会过期，而且**没人会注意到它过期了**。界面改了、主题调了、
 * 某个功能重做了，图还停在半年前——读者据此形成的第一印象是错的。
 * 脚本化之后重拍一次的成本是一条命令，过期就没有借口了。
 *
 * 顺带还有一个好处：这些图是**真应用真渲染**出来的，不是设计稿。
 * 图里那张表格的列宽、那段公式的排版、那张 mermaid 图，都是产品自己算的。
 *
 * ## 用法
 *
 *     pnpm screenshots            # macOS / Windows
 *     xvfb-run -a pnpm screenshots  # Linux（需要一个显示环境）
 *
 * 产物写进 `docs/public/shots/`，VitePress 会把它们原样发到站点根下。
 * **图是提交进仓库的**：让 Pages 的构建去跑一遍 Electron 太重，
 * 而这些图的更新频率远低于代码。
 */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const appRoot = path.join(repoRoot, 'apps/desktop')
const outDir = path.join(repoRoot, 'docs/public/shots')

/** 窗口内容区尺寸（CSS 像素）。截出来的 PNG 是它的两倍，见 SCALE。 */
const WIDTH = 1280
const HEIGHT = 800

/**
 * 设备像素比。
 *
 * 图要在 Retina 屏上不糊就得有 2 倍像素；而 CI 机器的 DPR 是 1，
 * 靠 Chromium 的 `--force-device-scale-factor` 强制拉上去，
 * 这样在任何机器上拍出来的尺寸都一致 —— 不一致的截图 diff 起来没法看。
 */
const SCALE = 2

/** 等一个选择器出现，失败时给出人能看懂的原因。 */
async function waitFor(page, selector, what) {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: 45_000 })
  } catch {
    throw new Error(`等不到${what}（选择器 ${selector}）——截图会缺内容，中止`)
  }
}

/**
 * 回到文档开头，并把光标停在**第二行那个空行**上。
 *
 * 不能停在第一行：那是标题，光标在里面时 `#` 会按产品规则显形 —— 行为是对的，
 * 但宣传图该展示的是「平时的样子」。空行上没有任何元素会被激活，
 * 插入符也只是一条不起眼的竖线。
 */
async function toTop(page) {
  await page.locator('.cm-content').click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(300)
}

/** 点一个真实的原生菜单项。 */
async function clickMenu(app, labels) {
  await app.evaluate(({ Menu }, target) => {
    let items = Menu.getApplicationMenu()?.items ?? []
    let found
    for (const label of target) {
      found = items.find((item) => item.label === label)
      if (!found) throw new Error(`菜单里找不到「${label}」`)
      items = found.submenu?.items ?? []
    }
    found?.click()
  }, labels)
}

/** 切主题并等它真的生效 —— 主题是异步落盘的，切完立刻拍会拍到旧的。 */
async function setTheme(app, page, id, label) {
  await clickMenu(app, ['视图', '主题', label])
  await page.waitForFunction(
    (expected) => document.documentElement.dataset['typoTheme'] === expected,
    id,
  )
  await page.waitForTimeout(200)
}

async function shoot(page, name, options = {}) {
  const file = path.join(outDir, `${name}.png`)
  await page.screenshot({ path: file, ...options })
  console.log(`  ✓ ${path.relative(repoRoot, file)}`)
}

async function main() {
  const userDataDir = path.join(tmpdir(), `typo-shots-${Date.now()}`)
  await mkdir(outDir, { recursive: true })

  // 样例文档拷进临时目录再打开：直接开仓库里那份的话，应用会把它记进
  // 「最近打开」与会话，还可能因为截图期间的误操作改到它
  const workDir = path.join(userDataDir, 'doc')
  await mkdir(workDir, { recursive: true })
  const docPath = path.join(workDir, '装饰即渲染.md')
  await writeFile(docPath, await readFile(path.join(here, 'sample.md'), 'utf8'), 'utf8')

  console.log('启动应用…')
  const app = await electron.launch({
    args: [
      appRoot,
      docPath,
      `--user-data-dir=${userDataDir}`,
      `--force-device-scale-factor=${SCALE}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
    env: { ...process.env, NODE_ENV: 'test' },
  })

  try {
    const page = await app.firstWindow()

    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        win?.setContentSize(size.width, size.height)
      },
      { width: WIDTH, height: HEIGHT },
    )

    await waitFor(page, '.cm-content', '编辑区')

    // 插入符在闪。不冻住它的话，同一条命令跑两次会得到两张不同的图 ——
    // 而「重跑一次产出不同结果」会让截图的 diff 完全没法看。
    // 只关掉动画，不隐藏光标：光标本身是「显形」那两张图要说明的东西。
    await page.addStyleTag({
      content: '.cm-cursorLayer { animation: none !important; }',
    })

    console.log('拍摄…')
    // —— 第一屏：标题、正文、表格、任务列表、公式 ——
    //
    // 公式是懒加载的，等它渲染完再拍
    await waitFor(page, '.cm-typo-math .katex', 'KaTeX 公式')
    await toTop(page)

    await setTheme(app, page, 'light', '浅色')
    await shoot(page, 'hero-light')

    await setTheme(app, page, 'dark', '深色')
    await shoot(page, 'hero-dark')

    // —— 第二屏：代码高亮与 mermaid ——
    //
    // **必须先滚过去再等**：CodeMirror 只渲染视口内的行，装饰引擎也只对可见区
    // 算装饰 —— 图表在视口外时那个 SVG 根本不存在，干等只会超时。
    await setTheme(app, page, 'light', '浅色')
    await page.keyboard.press('ControlOrMeta+End')
    await waitFor(page, '.cm-typo-mermaid svg', 'Mermaid 图表')

    // 定位到「管线」那一节的标题，而**不是靠滚动距离猜**。
    // 猜距离的写法一改文档就错位，而且错位了 CI 也不会告诉你 —— 图还是能出，
    // 只是拍歪了。按元素定位则要么对，要么当场报错。
    await page
      .locator('.cm-line', { hasText: '管线' })
      .first()
      .evaluate((el) => el.scrollIntoView({ block: 'start' }))
    // 标题顶着视口边缘不好看，往上让出一点
    await page.mouse.wheel(0, -48)
    await page.waitForTimeout(400)

    // 滚到文档末尾时编辑区底下有一大片留白（`padding-bottom: 40vh`，为了让最后
    // 一行也能停在舒服的位置）。按 mermaid 图的实际底边裁掉它 —— 写死一个高度
    // 的话，样例文档一改就又留白或者又切掉半张图
    const diagram = await page.locator('.cm-typo-mermaid').first().boundingBox()
    if (!diagram) throw new Error('找不到图表，没法决定裁到哪儿')
    await shoot(page, 'blocks-light', {
      clip: { x: 0, y: 0, width: WIDTH, height: Math.ceil(diagram.y + diagram.height + 40) },
    })

    // —— 「光标进入即显源码」：只能靠对比图说明 ——
    await toTop(page)

    const paragraph = page.locator('.cm-line', { hasText: '编辑器缓冲区里存的就是' }).first()
    const box = await paragraph.boundingBox()
    if (!box) throw new Error('找不到用来演示显形的那一段')

    // 上下各留一点余量，宽度取正文栏
    const clip = {
      x: Math.max(0, box.x - 24),
      y: Math.max(0, box.y - 16),
      width: Math.min(WIDTH - Math.max(0, box.x - 24), box.width + 48),
      height: box.height + 32,
    }

    await shoot(page, 'reveal-before', { clip })

    // 点进那句加粗文字里，`**` 就地显形
    await paragraph.locator('.cm-typo-strong').first().click()
    await page.waitForFunction(
      () => document.querySelector('.cm-typo-mark') !== null,
      undefined,
      { timeout: 10_000 },
    )
    await shoot(page, 'reveal-after', { clip })

    console.log('完成。')
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10 }).catch(
      () => undefined,
    )
  }
}

main().catch((error) => {
  console.error(`截图失败：${error.message}`)
  if (process.platform === 'linux' && !process.env['DISPLAY']) {
    console.error('Linux 上需要一个显示环境，试试：xvfb-run -a pnpm screenshots')
  }
  process.exit(1)
})
