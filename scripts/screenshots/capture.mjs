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
 * 产物写进 `docs/public/shots/<语言>/`，VitePress 会把它们原样发到站点根下。
 * **图是提交进仓库的**：让 Pages 的构建去跑一遍 Electron 太重，
 * 而这些图的更新频率远低于代码。
 *
 * ## 每种界面语言各拍一套
 *
 * 一个英文落地页配一张中文截图，读者第一眼看到的是「这个项目没做完」。
 * 样例文档按语言各写一份（`sample.<lang>.md`），脚本挨个跑一遍。
 * 加一种语言 = 加一份样例文档 + 在 `LANGS` 里加一行，不用改逻辑。
 *
 * **样例文档不是机器翻译的**：里面那句「光标进入即显源码」的说明是要被截进
 * 对比图里的，译得别扭的话，那张图就白拍了。
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

/**
 * 要拍哪几种语言，一种一行。
 *
 * `ui` 是**应用界面语言**的设置值，跟目录名分开列：它们碰巧一一对应，但那是巧合
 * 不是规律 —— 目录名用短代码（`zh`），设置里存的是完整标签（`zh-CN`）。合成一个
 * 值的话，加一种语言时会得到「文档是那个语言、状态栏还是英文」的截图。
 *
 * `paragraph` 与 `section` 是「光标进入即显源码」那组对比图的定位串：得指定
 * **在哪一段、点哪个词**上演示，而每种语言的措辞不同。写成整句里的一小截，
 * 而不是整句 —— 整句里任何一个标点改了都会找不到。
 */
const LANGS = [
  { id: 'zh', ui: 'zh-CN', paragraph: '编辑器缓冲区里存的就是', section: '管线' },
  { id: 'en', ui: 'en', paragraph: 'the editor buffer holds exactly', section: 'Pipeline' },
  { id: 'ja', ui: 'ja', paragraph: 'エディタのバッファには', section: 'パイプライン' },
]

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

/**
 * 发一条菜单命令。
 *
 * 走命令名而不是**点菜单标签**：界面语言现在跟着 `LANGS` 变，按标签找的话
 * 英文那一轮就会在「菜单里找不到『视图』」上挂掉。命令名是稳定的内部标识，
 * 而这条 IPC 正是原生菜单自己用的那条 —— 绕开的只有「找到那一项」这一步。
 *
 * 频道名在 `apps/desktop/src/shared/channels.ts`（`EVENTS.menuCommand`）。
 * 这里抄了一份字面量：脚本是 .mjs，读不了那边的 TS。
 */
async function sendCommand(app, command) {
  await app.evaluate(({ BrowserWindow }, name) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('没有窗口')
    win.webContents.send('event:menu-command', name)
  }, command)
}

/** 切主题并等它真的生效 —— 主题是异步落盘的，切完立刻拍会拍到旧的。 */
async function setTheme(app, page, id) {
  await sendCommand(app, `view.theme.${id}`)
  await page.waitForFunction(
    (expected) => document.documentElement.dataset['typoTheme'] === expected,
    id,
  )
  await page.waitForTimeout(200)
}

async function shoot(page, lang, name, options = {}) {
  const file = path.join(outDir, lang, `${name}.png`)
  await page.screenshot({ path: file, ...options })
  console.log(`  ✓ ${path.relative(repoRoot, file)}`)
}

/** 拍完一种语言的全套图。应用已经打开了对应的样例文档。 */
async function shootLang(app, page, lang) {
  await waitFor(page, '.cm-content', '编辑区')

  // 插入符在闪。不冻住它的话，同一条命令跑两次会得到两张不同的图 ——
  // 而「重跑一次产出不同结果」会让截图的 diff 完全没法看。
  // 只关掉动画，不隐藏光标：光标本身是「显形」那两张图要说明的东西。
  await page.addStyleTag({ content: '.cm-cursorLayer { animation: none !important; }' })

  // —— 第一屏：标题、正文、表格、任务列表、公式 ——
  //
  // 公式是懒加载的，等它渲染完再拍
  await waitFor(page, '.cm-typo-math .katex', 'KaTeX 公式')
  await toTop(page)

  await setTheme(app, page, 'light')
  await shoot(page, lang.id, 'hero-light')

  await setTheme(app, page, 'dark')
  await shoot(page, lang.id, 'hero-dark')

  // —— 第二屏：代码高亮与 mermaid ——
  //
  // **必须先滚过去再等**：CodeMirror 只渲染视口内的行，装饰引擎也只对可见区
  // 算装饰 —— 图表在视口外时那个 SVG 根本不存在，干等只会超时。
  await setTheme(app, page, 'light')
  await page.keyboard.press('ControlOrMeta+End')
  await waitFor(page, '.cm-typo-mermaid svg', 'Mermaid 图表')

  // 定位到那一节的标题，而**不是靠滚动距离猜**。猜距离的写法一改文档就错位，
  // 而且错位了 CI 也不会告诉你 —— 图还是能出，只是拍歪了。
  // 按元素定位则要么对，要么当场报错。
  const heading = page.locator('.cm-line', { hasText: lang.section }).first()
  if ((await heading.count()) === 0) {
    throw new Error(`[${lang.id}] 样例文档里找不到「${lang.section}」这一节`)
  }
  await heading.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  // 标题顶着视口边缘不好看，往上让出一点
  await page.mouse.wheel(0, -48)
  await page.waitForTimeout(400)

  // 滚到文档末尾时编辑区底下有一大片留白（`padding-bottom: 40vh`，为了让最后
  // 一行也能停在舒服的位置）。按 mermaid 图的实际底边裁掉它 —— 写死一个高度
  // 的话，样例文档一改就又留白或者又切掉半张图
  const diagram = await page.locator('.cm-typo-mermaid').first().boundingBox()
  if (!diagram) throw new Error(`[${lang.id}] 找不到图表，没法决定裁到哪儿`)
  await shoot(page, lang.id, 'blocks-light', {
    clip: { x: 0, y: 0, width: WIDTH, height: Math.ceil(diagram.y + diagram.height + 40) },
  })

  // —— 「光标进入即显源码」：只能靠对比图说明 ——
  await toTop(page)

  const paragraph = page.locator('.cm-line', { hasText: lang.paragraph }).first()
  const box = await paragraph.boundingBox()
  if (!box) throw new Error(`[${lang.id}] 找不到用来演示显形的那一段（「${lang.paragraph}」）`)

  // 上下各留一点余量，宽度取正文栏
  const clip = {
    x: Math.max(0, box.x - 24),
    y: Math.max(0, box.y - 16),
    width: Math.min(WIDTH - Math.max(0, box.x - 24), box.width + 48),
    height: box.height + 32,
  }

  await shoot(page, lang.id, 'reveal-before', { clip })

  // 点进那句加粗文字里，`**` 就地显形
  await paragraph.locator('.cm-typo-strong').first().click()
  await page.waitForFunction(
    () => document.querySelector('.cm-typo-mark') !== null,
    undefined,
    {
      timeout: 10_000,
    },
  )
  await shoot(page, lang.id, 'reveal-after', { clip })
}

/**
 * 每种语言**重开一次应用**，而不是在同一个窗口里换文档。
 *
 * 换文档要么走「打开文件」（会动到会话与最近打开），要么整片替换内容
 * （撤销栈里留着一次巨大的替换，而截图里的状态栏会把它暴露出来）。
 * 重开一次是几秒的事，换来的是每一套图都从同样干净的状态开始。
 */
async function shootAll() {
  await mkdir(outDir, { recursive: true })

  for (const lang of LANGS) {
    const userDataDir = path.join(tmpdir(), `typo-shots-${lang.id}-${Date.now()}`)
    await mkdir(userDataDir, { recursive: true })
    await mkdir(path.join(outDir, lang.id), { recursive: true })

    // 界面语言钉死，不看跑脚本这台机器的系统区域 —— 否则英文截图里的状态栏
    // 会随开发机的设置变，而那种漂移只有对比新旧图时才看得出来
    await writeFile(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ 'ui.language': lang.ui }),
      'utf8',
    )

    // 样例文档拷进临时目录再打开：直接开仓库里那份的话，应用会把它记进
    // 「最近打开」与会话，还可能因为截图期间的误操作改到它
    const workDir = path.join(userDataDir, 'doc')
    await mkdir(workDir, { recursive: true })
    const source = await readFile(path.join(here, `sample.${lang.id}.md`), 'utf8')
    // 文件名会出现在状态栏里，所以取样例文档自己的一级标题
    const title = (/^#\s+(.+)$/m.exec(source)?.[1] ?? lang.id).trim()
    const docPath = path.join(workDir, `${title}.md`)
    await writeFile(docPath, source, 'utf8')

    console.log(`[${lang.id}] 启动应用…`)
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
          BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
        },
        { width: WIDTH, height: HEIGHT },
      )
      await shootLang(app, page, lang)
    } finally {
      await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 10 }).catch(
        () => undefined,
      )
    }
  }

  console.log('完成。')
}

shootAll().catch((error) => {
  console.error(`截图失败：${error.message}`)
  if (process.platform === 'linux' && !process.env['DISPLAY']) {
    console.error('Linux 上需要一个显示环境，试试：xvfb-run -a pnpm screenshots')
  }
  process.exit(1)
})
