/**
 * 独立运行验收（脱离 DSH）
 *
 * 验证：
 *   A 零三方依赖 / 零 DSH 引用（静态扫描）
 *   B 每日任务真跑一次 → 产出 base.json（含 schema 校验）与 md/csv
 *   C 幂等：当日已完成时跳过
 *   D 实时服务能独立加载该 base.json 并对外提供 HTTP/SSE/前端
 *   E 前端页面含必需区块（双榜 + 日K线/硬逻辑/溯源 预留位）
 *
 * 用法：node test/verify-standalone.mjs [--skip-daily]   （--skip-daily 跳过 90s 的真实抓取）
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STANDALONE = resolve(HERE, '..')
const WORKSPACE = resolve(STANDALONE, '..')
const SCRATCH = join(STANDALONE, 'var-verify')
const SKIP_DAILY = process.argv.includes('--skip-daily')

const results = []
function check(id, name, cond, extra = '') {
  results.push({ id, name, pass: !!cond, extra })
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== A 零三方依赖 / 零 DSH 引用 ===')
{
  // 独立运行链路的**运行时闭包**：standalone 自身 + realtime-server + rank20-daemon/dist 的
  // 零依赖模块。刻意排除两处，它们不属于独立运行路径：
  //   · rank20-daemon/dist/index.js —— DSH 插件外壳（可选；独立任务不加载它）
  //   · 本测试文件自身（内含用于扫描的关键字字面量）
  const SCAN = [
    { dir: STANDALONE, skip: /var-|test[\\/]|\.log$/ },
    { dir: join(WORKSPACE, 'realtime-server'), skip: /var-|test[\\/]|\.log$/ },
    {
      dir: join(WORKSPACE, 'rank20-daemon', 'dist'),
      skip: /index\.js$/, // DSH 插件外壳，见上
    },
  ]
  const bad = []
  const dshHits = []
  for (const { dir, skip } of SCAN) {
    if (!existsSync(dir)) continue
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (/node_modules|[\\/]lib[\\/]/.test(p) || (skip && skip.test(p))) continue
        if (e.isDirectory()) {
          walk(p)
          continue
        }
        if (!/\.(mjs|js|html|css|json)$/.test(e.name)) continue
        const src = readFileSync(p, 'utf8')
        if (/\.(mjs|js)$/.test(e.name)) {
          for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
            const spec = m[1]
            if (spec.startsWith('.') || spec.startsWith('node:')) continue
            bad.push(`${p.replace(WORKSPACE, '')} → ${spec}`)
          }
        }
        for (const m of src.matchAll(/\b(cordis|@deepseek-ai|dsh-[a-z]+)\b/g)) {
          dshHits.push(`${p.replace(WORKSPACE, '')}:${m[1]}`)
        }
      }
    }
    walk(dir)
  }
  check('A1', '独立运行时闭包内全部 import 只有相对路径与 node: 内置模块', bad.length === 0, bad.slice(0, 5).join(' ; ') || '零三方依赖')
  check('A2', '独立运行时闭包不引用 cordis / @deepseek-ai / dsh-*', dshHits.length === 0, dshHits.slice(0, 5).join(' ; ') || '零引用')

  // 单独报告被排除的文件，避免"看起来漏检"
  const shell = join(WORKSPACE, 'rank20-daemon', 'dist', 'index.js')
  const shellNeeds = existsSync(shell)
    ? [...readFileSync(shell, 'utf8').matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)].map((m) => m[1])
    : []
  console.log(
    `    （已排除 DSH 插件外壳 dist/index.js${shellNeeds.length ? `，它需要 ${[...new Set(shellNeeds)].join(', ')}` : ''}；独立入口不加载它）`,
  )
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== B 独立每日任务真跑一次 ===')
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

const daily = await import('../daily-job.mjs')
let dailyResult = null
if (SKIP_DAILY) {
  console.log('  （--skip-daily：复用已有 base.json 继续验证 C/D/E）')
} else {
  const t0 = Date.now()
  try {
    dailyResult = await daily.runDailyJob({
      outDir: SCRATCH,
      varDir: SCRATCH,
      lookbackDays: 32,
      force: true,
      log: (m) => {
        if (/✓ 完成|✗|失败/.test(m)) console.log(`    [daily] ${m}`)
      },
    })
  } catch (e) {
    console.log(`    [daily] 异常：${e.message}`)
  }
  check('B1', `每日任务在 ${((Date.now() - t0) / 1000).toFixed(0)}s 内完成`, !!dailyResult && !dailyResult.skipped)
}

const basePath = join(SCRATCH, 'base.json')
if (!existsSync(basePath)) {
  // 退化：把工作区现有 base.json 复制过来做 C/D/E
  const real = join(WORKSPACE, 'rank20', 'base.json')
  if (existsSync(real)) {
    const { copyFileSync } = await import('node:fs')
    const { localDay } = await import('../../rank20-daemon/dist/naming.js')
    copyFileSync(real, basePath)
    // ⚠️ 幂等判据是"generatedAt 属**今天**"。工作区那份可能是昨天生成的
    // （例如跨零点后再跑本测试），直接复用会让 C1/C2 误判为"今日未完成"
    // 并真的触发一次抓取。作为测试夹具，这里把它规整成"今天生成"。
    const doc = JSON.parse(readFileSync(basePath, 'utf8'))
    if (localDay(new Date(doc.generatedAt)) !== localDay()) {
      console.log(`    （夹具规整：generatedAt ${doc.generatedAt} → 现在，使幂等判据指向"今天"）`)
      doc.generatedAt = new Date().toISOString()
      writeFileSync(basePath, JSON.stringify(doc, null, 2))
    }
    console.log('    （已复制工作区 base.json 作为被测输入）')
  }
}

check('B2', '产出 base.json', existsSync(basePath))
let baseDoc = null
if (existsSync(basePath)) {
  baseDoc = JSON.parse(readFileSync(basePath, 'utf8'))
  const rowOk = Array.isArray(baseDoc.rows) && baseDoc.rows.every((r) => r.variety && r.contract && r.baseSettle > 0 && r.baseDate)
  check('B3', 'base.json schemaVersion=1 且行含铁律字段', baseDoc.schemaVersion === 1 && rowOk, `rows=${baseDoc.rows?.length}`)
  // 品种数是**数据决定**的（R4：主力须在 T−20 有基准价；新挂牌品种会被剔除），
  // 不写死数字 —— 与 D3 一样以基准表自身行数为准。
  check('B4', `品种数 = 基准表行数（${baseDoc.rows?.length}）`, baseDoc.rows?.length > 0 && baseDoc.rows.length >= 80, `rows=${baseDoc.rows?.length}`)
  check('B5', '交易日历足够覆盖 T−20', Array.isArray(baseDoc.tradingDates) && baseDoc.tradingDates.length >= 21, `${baseDoc.tradingDates?.length} 天`)
  if (!SKIP_DAILY) {
    // 只有真跑过独立任务才断言"产出者标识"与台账文件（--skip-daily 复用的是工作区已有 base.json）
    check('B6', 'source 标注为独立任务', baseDoc.source === 'standalone-daily-job', baseDoc.source)
  }
}
if (!SKIP_DAILY) {
  const mdFiles = existsSync(SCRATCH) ? readdirSync(SCRATCH).filter((f) => /^\d{4}年.*\.md$/.test(f)) : []
  check('B7', '产出台账 md（YYYY年MM月DD日HH时.md）', mdFiles.length > 0, mdFiles.join(','))
  check('B8', '产出 latest.md 与 csv', existsSync(join(SCRATCH, 'latest.md')) && readdirSync(SCRATCH).some((f) => f.endsWith('.csv')))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== C 幂等：当日已完成则跳过 ===')
{
  const done = daily.completedToday(SCRATCH)
  check('C1', 'completedToday() 判定为已完成', done.done, done.reason ?? '')
  const r = await daily.runDailyJob({ outDir: SCRATCH, varDir: SCRATCH, log: null })
  check('C2', '再次调用直接跳过，不重复抓取', r.skipped === true, r.reason ?? '')
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== D 实时服务独立加载 base.json 并提供 HTTP/SSE ===')
process.env.RT_PORT = '8896'
process.env.RT_BASE = basePath
process.env.RT_OUT = SCRATCH
process.env.RT_VAR = SCRATCH

const { main: startRealtime } = await import('../../realtime-server/src/index.mjs')
const rt = await startRealtime({ installSignalHandlers: false })
const BASE = `http://127.0.0.1:${process.env.RT_PORT}`

/**
 * 等待快照。
 * 轮询器启动时会先用**日报口径**播种一份快照（seq=1，liveCount=0，休市不空白），
 * 所以交易时段必须再多等一轮**真实换价**的快照，否则断言到的是播种快照。
 */
async function waitSnapshot(timeoutMs = 25000) {
  const { inTradingWindow } = await import('../../realtime-server/src/config.mjs')
  const trading = inTradingWindow()
  const t0 = Date.now()
  let seeded = null
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/rank20/latest`)
      if (r.status === 200) {
        const j = await r.json()
        if (j.seq > 0) {
          if (j.liveCount > 0 || !trading) return j
          seeded = seeded ?? j
        }
      }
    } catch {
      /* retry */
    }
    await new Promise((s) => setTimeout(s, 500))
  }
  return seeded
}

const snap = await waitSnapshot()
check('D1', '实时服务加载基准表并产出快照', !!snap, snap ? `seq=${snap.seq} 交易日=${snap.tradeDate} 基准日=${snap.baseDate}` : '超时')
if (snap) {
  check('D2', '榜单完整：涨 20 + 跌 20', snap.gainers.length === 20 && snap.losers.length === 20)
  check('D3', `品种数 = base.json 行数（${baseDoc?.rows?.length}）`, snap.all.length === baseDoc?.rows?.length, `${snap.all.length}`)
  // 覆盖率断言要看是否在交易时段：休市时轮询器**按设计不发请求**，
  // 此时应当是"0 实时换价 + 全部标记为日报口径"，而不是硬套 90%。
  const { inTradingWindow } = await import('../../realtime-server/src/config.mjs')
  const trading = inTradingWindow()
  if (trading) {
    check('D4', '交易时段：实时换价覆盖率 ≥ 90%', snap.liveCount / snap.total >= 0.9, `${snap.liveCount}/${snap.total}`)
  } else {
    const allDaily = snap.all.every((r) => r.is_live === false && r.source === 'daily_snapshot')
    check('D4', '休市：全量为日报口径且明确标记非实时', snap.liveCount === 0 && allDaily, `换价=${snap.liveCount}/${snap.total}`)
  }
}

const h = await fetch(`${BASE}/api/health`).then((r) => r.json())
check('D5', '/api/health 正常', h.ok === true && h.poller.source.state !== 'down', `source=${h.poller.source.state} cycles=${h.poller.cycles}`)

const page = await fetch(`${BASE}/`).then((r) => r.text())
check('D6', '前端首页可访问', page.includes('涨幅榜') && page.includes('跌幅榜'))

const ev = []
{
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 8000)
  try {
    const res = await fetch(`${BASE}/events`, { signal: ctl.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (ev.length < 2) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const m = /^event: (\w+)/m.exec(chunk)
        if (m) ev.push(m[1])
      }
    }
    ctl.abort()
  } catch {
    /* abort 收尾 */
  }
}
check('D7', 'SSE 推送 hello → snapshot', ev.includes('hello') && ev.includes('snapshot'), ev.join(' → '))

await rt.close()

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== E 前端页面区块完整性（行内就地展开 + 导航条）===')
{
  const html = readFileSync(join(WORKSPACE, 'realtime-server', 'web', 'index.html'), 'utf8')
  const js = readFileSync(join(WORKSPACE, 'realtime-server', 'web', 'app.js'), 'utf8')
  check('E1', '双榜区域', html.includes('boardGain') && html.includes('boardLoss'))
  check('E2', '日K线：点击行就地展开 + Canvas 蜡烛图', js.includes('buildExpandRow') && js.includes("getContext('2d')"))
  check('E3', '硬逻辑板块（方向 + 做多/做空硬逻辑 + 失效条件）',
    js.includes('renderLogic') && js.includes('做多 / 做空硬逻辑') && js.includes('失效条件'))
  check('E3b', '题材龙头板块独立（涨跌题材 / 龙头地位 / 确认日）',
    js.includes('renderTheme') && js.includes('涨跌题材') && js.includes('龙头地位') && js.includes('确认日'))
  check('E4', '面板导航条含 日K图 / 硬逻辑 / 题材龙头 / 数据溯源 四个板块',
    js.includes('panelNav') && js.includes('日K图') && js.includes('硬逻辑') && js.includes('题材龙头') && js.includes('数据溯源'))
  const css = readFileSync(join(WORKSPACE, 'realtime-server', 'web', 'style.css'), 'utf8')
  /*
   * 等高机制在 2026-09-21 已从「CSS 固定 --panelH 高度 + 内部滚动」改为
   * 「JS 实测四板块最大内容高度后内联设定」——后者才满足用户硬要求
   * 「内容完全展示、不要内部滚动条」。此处断言改后的真实机制。
   */
  check('E4b', '四板块页面等高：JS 实测最大高度内联设定 + 无内部滚动条',
    js.includes('fitPanelHeight') && /body\.style\.height\s*=/.test(js) &&
      /\.panelBody\s*\{[^}]*height:\s*auto/.test(css) && /\.panelBody\s*\{[^}]*overflow:\s*visible/.test(css),
    'fitPanelHeight + .panelBody{height:auto;overflow:visible}')
  check('E4c', 'K线图含时间横轴 + 点击固定读数面板',
    js.includes('时间横轴') && js.includes('barReadout') && js.includes('ex.picked'))
  check('E5', '状态徽章（连接/数据源/换价）', html.includes('connPill') && html.includes('srcPill') && html.includes('livePill'))
  check('E6', '左侧抽屉已移除（改为行内展开）', !html.includes('class="drawer"'))
  check('E7', '合规页脚', html.includes('局域网内部自用'))
}

// ══════════════════════════════════════════════════════════════════════════
rmSync(SCRATCH, { recursive: true, force: true })

const pass = results.filter((r) => r.pass).length
const fail = results.length - pass
console.log(`\n=== 结果：${pass}/${results.length} 通过${fail ? `，${fail} 失败` : ''} ===`)
if (fail) for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.id} ${r.name} ${r.extra}`)
process.exit(fail ? 1 : 0)
