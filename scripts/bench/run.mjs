/**
 * 性能基准（07 §2）。
 *
 *     pnpm bench                 # macOS / Windows
 *     xvfb-run -a pnpm bench     # Linux
 *     pnpm bench --update        # 把这次的结果写回 benchmarks/baseline.json
 *
 * ## 时间指标只报告，不卡门槛 —— 这是对 07 §2 的一处修正
 *
 * 07 §2 写的是「在 CI 里是**硬门槛**，不是参考值」。真去做的时候这条站不住：
 * GitHub 的共享 runner 上，同一份代码连着跑三次能差出两三倍（邻居在编译，
 * 或者你抽到了一台老 CPU）。把时间设成硬门槛，结果不是「守住了性能」，
 * 是「一半的 PR 随机变红，于是所有人学会了点 re-run」—— 那比没有门槛更糟，
 * 它训练所有人忽略这个信号。
 *
 * 所以分成两档：
 *
 * - **体积**（bundle.mjs）：确定性的，卡死；
 * - **时间与内存**：跑、记录、写进 CI 的 summary，跟基线一起显示。人来判断。
 *
 * 基线里存的是**开发容器上的数字**，不是「合格线」。它的用处是「这次比上次慢了
 * 一倍」这种量级的变化 —— 那种变化再吵的机器也盖不住。
 *
 * ## 每个指标都跑 N 次取分位数
 *
 * 单次测量在任何机器上都没有意义。冷启动尤其：第一次跑要读盘、要 JIT，
 * 第二次就快一截。所以冷启动每次**重开一个进程**，其余指标在同一个窗口里
 * 重复采样。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'
import { formatBundle, measureBundle, MAIN_BUNDLE_BUDGET } from './bundle.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const appRoot = path.join(repoRoot, 'apps/desktop')
const baselineFile = path.join(repoRoot, 'benchmarks/baseline.json')

/** 冷启动测几次。每次都是一个新进程，所以这一项最贵。 */
const COLD_RUNS = 5
/** 按键延迟采样多少次。 */
const KEY_SAMPLES = 120
/** 打开大文档测几次。 */
const OPEN_RUNS = 5

const ACTIVE_CONTENT = '.tab-page:not([hidden]) .cm-content'

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[at]
}

const median = (values) => quantile(values, 0.5)

/** 生成一篇有代表性的文档：正文、标题、列表、表格、代码块各占一些。 */
function makeDoc(lines) {
  const out = []
  for (let i = 0; out.length < lines; i++) {
    out.push(`## 第 ${i + 1} 节`)
    out.push('')
    out.push(`这是第 ${i + 1} 段正文，里面有 **加粗**、*斜体* 和 \`行内代码\`。`)
    out.push('')
    out.push('- 列表项一')
    out.push('- 列表项二')
    out.push('')
  }
  return out.slice(0, lines).join('\n')
}

async function launch(userDataDir, extraArgs = []) {
  return electron.launch({
    args: [
      appRoot,
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      ...extraArgs,
    ],
    env: { ...process.env, NODE_ENV: 'test' },
  })
}

/** 一个干净的 userData 目录，界面语言钉死（免得跟机器区域有关）。 */
async function freshUserData() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mosu-bench-'))
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ 'ui.language': 'zh-CN' }))
  return dir
}

/**
 * 冷启动到可输入。
 *
 * 终点取「编辑区可见**且**真的吃得下按键」，而不是「窗口出现了」——
 * 窗口先出来、编辑器还在初始化的那段时间用户是打不了字的，
 * 只测到窗口出现等于测了个好看的数。
 */
async function benchColdStart() {
  const samples = []
  for (let i = 0; i < COLD_RUNS; i++) {
    const userDataDir = await freshUserData()
    const started = Date.now()
    const app = await launch(userDataDir)
    try {
      const page = await app.firstWindow()
      await page.waitForSelector(ACTIVE_CONTENT, { state: 'visible', timeout: 60_000 })
      await page.locator(ACTIVE_CONTENT).click()
      await page.keyboard.type('x')
      await page.waitForFunction(
        () =>
          (
            document.querySelector('.tab-page:not([hidden]) .cm-content')?.textContent ?? ''
          ).includes('x'),
        undefined,
        { timeout: 30_000 },
      )
      samples.push(Date.now() - started)
    } finally {
      await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined)
      await app.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 10 }).catch(
        () => undefined,
      )
    }
  }
  return samples
}

/**
 * 按键的代价，两个数。
 *
 * 在页面里量而不是从 Playwright 那侧算 —— 后者包含一次 IPC 往返和 Playwright
 * 自己的调度，量出来的是「自动化框架有多快」。
 *
 * ## 为什么必须分成两个数
 *
 * 第一版只量到「下一帧绘制完成」，结果中位数 16.9ms、p95 17.3ms —— 而 60Hz 下
 * 一帧就是 16.7ms。**那个数的下限是由帧率决定的**，永远低不过一帧，跟代码快慢
 * 基本无关；拿它去比 16ms 的预算，等于设了一个构造上就达不到的门槛。
 *
 * 所以：
 *
 * - `work`：派发 `beforeinput` 到**强制刷完样式与布局**为止的同步耗时。
 *   这是「一次按键吃掉多少帧预算」，是真正可以优化、也真正该跟 16ms 比的数。
 *   读一次 `getBoundingClientRect()` 把布局逼出来 —— 不逼的话浏览器会把布局
 *   推迟到帧末，测出来的是个漂亮的假数。
 * - `toPaint`：到下一次绘制的墙钟时间。它的用处不是跟预算比，是看**它是不是
 *   一帧的整数倍** —— 明显超过一帧就意味着掉帧了。
 */
async function benchKeystroke(page) {
  return page.evaluate(async (samples) => {
    const content = document.querySelector('.tab-page:not([hidden]) .cm-content')
    if (!content) throw new Error('找不到编辑区')

    const afterPaint = () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => resolve()
          channel.port2.postMessage(null)
        })
      })

    const work = []
    const toPaint = []
    for (let i = 0; i < samples; i++) {
      const started = performance.now()
      // 直接派发 beforeinput：这是浏览器真正送给 contenteditable 的那个事件，
      // CodeMirror 的输入处理就挂在它上面
      content.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: 'a',
          bubbles: true,
          cancelable: true,
        }),
      )
      content.getBoundingClientRect()
      work.push(performance.now() - started)
      await afterPaint()
      toPaint.push(performance.now() - started)
    }
    return { work, toPaint }
  }, KEY_SAMPLES)
}

/** 打开一篇大文档到可编辑。 */
async function benchOpen(page, text) {
  const samples = []
  for (let i = 0; i < OPEN_RUNS; i++) {
    samples.push(
      await page.evaluate(async (doc) => {
        const started = performance.now()
        // 走真实的粘贴通路，跟用户打开一篇文档后编辑器要做的事一样：
        // 全量解析 + 视口装饰 + 布局
        const content = document.querySelector('.tab-page:not([hidden]) .cm-content')
        if (!content) throw new Error('找不到编辑区')
        const transfer = new DataTransfer()
        transfer.setData('text/plain', doc)
        content.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }),
        )
        await new Promise((resolve) => requestAnimationFrame(() => resolve()))
        return performance.now() - started
      }, text),
    )
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
  }
  return samples
}

/** 空闲内存。取 main 进程加所有渲染进程 —— 只报 main 会漏掉大头。 */
async function benchMemory(app) {
  const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics())
  return metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0) / 1024
}

async function main() {
  const update = process.argv.includes('--update')

  console.log('量主 bundle…')
  const bundle = await measureBundle()
  console.log(formatBundle(bundle))

  console.log(`\n冷启动 ×${COLD_RUNS}…`)
  const cold = await benchColdStart()

  const userDataDir = await freshUserData()
  const app = await launch(userDataDir)
  let keystroke
  let open10k
  let memoryMb
  try {
    const page = await app.firstWindow()
    await page.waitForSelector(ACTIVE_CONTENT, { state: 'visible', timeout: 60_000 })
    await page.locator(ACTIVE_CONTENT).click()

    console.log(`按键延迟（1k 行文档）×${KEY_SAMPLES}…`)
    await page.evaluate(async (doc) => {
      const content = document.querySelector('.tab-page:not([hidden]) .cm-content')
      const transfer = new DataTransfer()
      transfer.setData('text/plain', doc)
      content?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
    }, makeDoc(1000))
    keystroke = await benchKeystroke(page)

    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')

    console.log(`打开 10k 行 ×${OPEN_RUNS}…`)
    open10k = await benchOpen(page, makeDoc(10_000))

    memoryMb = await benchMemory(app)

    // 关窗前清空：脏文档会弹原生「是否保存」，而那个框在这里没人点
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
  } finally {
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined)
    await app.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10 }).catch(
      () => undefined,
    )
  }

  const result = {
    coldStartMs: Math.round(median(cold)),
    keystrokeP95Ms: Number(quantile(keystroke.work, 0.95).toFixed(2)),
    keystrokeMedianMs: Number(median(keystroke.work).toFixed(2)),
    keystrokeToPaintP95Ms: Number(quantile(keystroke.toPaint, 0.95).toFixed(2)),
    open10kMs: Math.round(median(open10k)),
    idleMemoryMb: Math.round(memoryMb),
    mainBundleBytes: bundle.main,
    lazyBytes: bundle.lazy,
  }

  const baseline = await readFile(baselineFile, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null)

  console.log(`\n${report(result, baseline?.metrics ?? null)}`)

  if (update) {
    await writeFile(
      baselineFile,
      `${JSON.stringify({ recordedAt: new Date().toISOString().slice(0, 10), metrics: result }, null, 2)}\n`,
      'utf8',
    )
    console.log(`\n已写回 ${path.relative(repoRoot, baselineFile)}`)
  }

  if (result.mainBundleBytes > MAIN_BUNDLE_BUDGET) {
    console.error('\n主 bundle 超预算 —— 这一项是硬门槛')
    process.exit(1)
  }
}

/** 预算表：`[键, 名称, 预算, 单位]`。预算为 null 表示只观察。 */
const BUDGETS = [
  ['keystrokeP95Ms', '按键处理 p95（1k 行，含布局）', 16, 'ms'],
  ['keystrokeMedianMs', '按键处理 中位数', null, 'ms'],
  ['keystrokeToPaintP95Ms', '按键 → 下一次绘制 p95', null, 'ms'],
  ['open10kMs', '打开 10k 行到可编辑', 300, 'ms'],
  ['coldStartMs', '冷启动到可输入', 1500, 'ms'],
  ['idleMemoryMb', '空闲内存（全进程）', 300, 'MB'],
]

function report(result, baseline) {
  const rows = BUDGETS.map(([key, label, budget, unit]) => {
    const value = result[key]
    const before = baseline?.[key]
    const delta =
      typeof before === 'number' && before > 0
        ? `${value >= before ? '+' : ''}${(((value - before) / before) * 100).toFixed(0)}%`
        : '—'
    const verdict = budget === null ? '—' : value <= budget ? '✓' : '⚠'
    return `| ${label} | ${value} ${unit} | ${budget === null ? '—' : `${budget} ${unit}`} | ${delta} | ${verdict} |`
  })
  return [
    '| 指标 | 本次 | 预算 | 对比基线 | |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    `| 主 bundle | ${(result.mainBundleBytes / 1024 / 1024).toFixed(2)} MB | 3.00 MB | — | ${result.mainBundleBytes <= MAIN_BUNDLE_BUDGET ? '✓' : '✗'} |`,
    '',
    '⚠ 表示超预算但**不会让构建失败** —— 时间指标在共享 runner 上噪声太大，',
    '只有主 bundle 体积是硬门槛。理由见这个文件开头。',
    '',
    '「按键 → 下一次绘制」没有预算：60Hz 下它的下限就是 16.7ms，跟代码快慢无关。',
    '它明显超过一帧才有意义 —— 那说明掉帧了。',
  ].join('\n')
}

await main()
