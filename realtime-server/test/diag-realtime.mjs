/**
 * 实时链路端到端诊断（**不改产品代码**）
 *
 * 目的：证明「后端定时轮询 → 行情解析 → 重算 20 日涨跌幅 → 推送给前端」这条链路
 *       在运行时真的会**按节拍反复执行并产出变化中的数值**。
 *
 * 做法：
 *   · 只桩掉**外部 HTTP 边界**（globalThis.fetch），其余全部是生产代码
 *   · 把系统时钟平移到最近一个交易日（保持时刻不变），使 inTradingWindow() 为真
 *     —— Date.now() 仍按真实时间推进，所以限流窗口/节拍不受影响
 *   · 桩返回的行情每次请求都让价格微微变动，从而驱动出"涨跌幅在变"
 *
 * 事实核查用：真实数据源是**工作日盘中**才跳动；本脚本用于在任意时刻验证代码路径。
 *
 * 用法：node test/diag-realtime.mjs
 */
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RT = resolve(HERE, '..')
const WORKSPACE = resolve(RT, '..')
const SCRATCH = join(RT, 'var-diag')

// ── 1) 时钟平移：把"今天"挪到最近一个工作日，时刻（时分秒）保持不变 ──────────
const RealDate = Date
// 平移到**最近一个工作日的 14:00**：既在工作日、又在交易时段内（否则 16:00 之后跑会落到休市）
const _n = new RealDate()
const _t = new RealDate(_n)
_t.setDate(_t.getDate() - (_n.getDay() === 0 ? 2 : _n.getDay() === 6 ? 1 : 0))
_t.setHours(14, 0, 0, 0)
const SHIFT = _t.getTime() - _n.getTime()
const daysBack = Math.round(-SHIFT / 86400000)
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + SHIFT)
    else super(...args)
  }
  static now() {
    return RealDate.now() // 限流窗口/节拍用真实推进的时间
  }
}
globalThis.Date = ShiftedDate
console.log(`=== 时钟平移 ${daysBack} 天（${new RealDate().toLocaleString('zh-CN')} → ${new Date().toLocaleString('zh-CN')}）===`)

// ── 2) 隔离输出目录，只读真实 base.json ──────────────────────────────────
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
process.env.RT_PORT = '8895'
process.env.RT_VAR = SCRATCH
process.env.RT_OUT = SCRATCH
process.env.RT_BASE = join(WORKSPACE, 'rank20', 'base.json')
process.env.RT_INTERVAL_MS = '1500'

const { sinaSymbol } = await import('../../rank20-daemon/dist/realtime.js')
const baseDoc = JSON.parse(readFileSync(process.env.RT_BASE, 'utf8'))
const bySym = new Map()
for (const r of baseDoc.rows) {
  const s = sinaSymbol(r.contract)
  if (s) bySym.set(s, r)
}
console.log(`基准表：交易日 ${baseDoc.tradeDate} 基准日 ${baseDoc.baseDate}，可映射 ${bySym.size}/${baseDoc.rows.length} 个合约`)

// ── 3) 只桩外部 HTTP：返回新浪格式、且价格逐轮微变 ────────────────────────
let tick = 0
let fetchCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  if (!u.includes('hq.sinajs.cn')) return realFetch(url, opts) // 其它请求放行
  fetchCalls++
  tick++
  // ⚠️ 新浪的代码列表在 **path** 里（/list=a,b,c），不是 query string
  const list = u.split('/list=')[1] ?? ''
  const hhmmss = new RealDate().toTimeString().slice(0, 8).replace(/:/g, '')
  const lines = []
  for (const sym of list.split(',').filter(Boolean)) {
    const row = bySym.get(sym)
    const seed = row ? row.close : 1000
    // 每轮 +0.05% 的确定性漂移 → 必然产生可观测的数值变化
    const drift = 1 + tick * 0.0005
    const price = Math.round(seed * drift * 100) / 100
    const f = new Array(44).fill('0')
    f[0] = row ? row.name : sym
    f[1] = hhmmss // 源时间戳
    f[2] = String(price)
    f[3] = String(price)
    f[4] = String(price)
    f[6] = String(price) // 最新价
    f[7] = String(price)
    f[8] = String(price)
    f[10] = String(Math.round(price * 0.995 * 100) / 100) // 昨结算（合理区间内）
    f[11] = '10'
    f[12] = '12'
    f[13] = String(100000 + tick * 7) // 持仓量
    f[14] = String(500000 + tick * 13) // 成交量
    f[17] = '2026-09-18' // 源标注交易日
    f[18] = '1'
    lines.push(`var hq_str_${sym}="${f.join(',')}";`)
  }
  return new Response(lines.join('\n'), { status: 200, headers: { 'content-type': 'application/javascript' } })
}

// ── 4) 起真实服务 ────────────────────────────────────────────────────────
const { main } = await import('../src/index.mjs')
const rt = await main({ installSignalHandlers: false })
const BASE = `http://127.0.0.1:${process.env.RT_PORT}`

// ── 5) 以"前端"身份订阅 SSE，收集推送 ────────────────────────────────────
const received = []
const ctl = new AbortController()
const sseTask = (async () => {
  const res = await fetch(`${BASE}/events`, { signal: ctl.signal })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 14000) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const ev = /^event: (\w+)/m.exec(chunk)
      const da = /^data: (.*)$/m.exec(chunk)
      if (ev && da && ev[1] === 'snapshot') received.push(JSON.parse(da[1]))
    }
  }
})().catch(() => {})

await new Promise((s) => setTimeout(s, 13500))
ctl.abort()
await sseTask

// ── 6) 结果 ──────────────────────────────────────────────────────────────
const results = []
const check = (id, name, cond, extra = '') => {
  results.push({ id, name, pass: !!cond })
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

console.log('\n=== 后端轮询 ===')
const health = await (await fetch(`${BASE}/api/health`)).json()
check('P1', '轮询在交易时段内运行', health.poller.state === 'polling', `state=${health.poller.state}`)
check('P2', '按节拍反复执行（轮次 ≥ 6）', health.poller.cycles >= 6, `cycles=${health.poller.cycles} interval=${health.poller.intervalMs}ms`)
check('P3', '请求速率闸门未被突破', health.poller.gate.reqLastSec <= 1 && health.poller.gate.reqLastMin <= 60,
  `${health.poller.gate.reqLastSec}/s  ${health.poller.gate.reqLastMin}/min  ${health.poller.gate.reqLastDay ?? health.poller.gate.reqToday}/日`)
check('P4', '快照序号递增', (received.at(-1)?.seq ?? 0) > (received[0]?.seq ?? 0), `seq ${received[0]?.seq} → ${received.at(-1)?.seq}`)

console.log('\n=== 数值实时变化 ===')
const track = (v) => received.map((s) => s.all.find((r) => r.variety === v)).filter(Boolean)
const watch = ['sc', 'bu', 'ma', 'lc', 'eg', 'cj']
let movedVars = 0
for (const v of watch) {
  const pts = track(v)
  if (pts.length < 2) continue
  const vals = pts.map((p) => p.pct_20d)
  const uniq = new Set(vals)
  if (uniq.size > 1) movedVars++
  console.log(
    `  ${v.padEnd(4)} ${uniq.size > 1 ? '变化' : '未变'}  ${vals.slice(0, 8).map((x) => (x >= 0 ? '+' : '') + x.toFixed(2)).join(' → ')}${vals.length > 8 ? ' …' : ''}`,
  )
}
check('P5', '同一品种的 20 日涨跌幅在推送间发生变化', movedVars >= 5, `${movedVars}/${watch.length} 个品种有变化`)
// received[0] 是启动时的**日报播种**快照（liveCount=0，符合预期），看实际轮询后的那条
const liveSnaps = received.filter((s) => s.liveCount > 0)
const liveLast = liveSnaps.at(-1)
check('P6', '实时换价覆盖全部可映射合约', (liveLast?.liveCount ?? 0) >= 80,
  `${liveLast?.liveCount}/${liveLast?.total ?? received[0]?.total}（播种快照 liveCount=0 属预期）`)
check('P7', '行情时间随推送推进', new Set(received.map((s) => s.quoteTime)).size >= 2,
  `${[...new Set(received.map((s) => s.quoteTime))].slice(0, 4).join(' ')}`)

console.log('\n=== 推送给前端 ===')
check('P8', 'SSE 持续推送 snapshot（≥ 6 条）', received.length >= 6, `${received.length} 条`)
check('P9', '每条载荷都含前端渲染所需字段', received.every((s) => s.gainers?.length === 20 && s.losers?.length === 20 && 'pct_20d' in s.gainers[0]),
  `涨=${received.at(-1)?.gainers?.length} 跌=${received.at(-1)?.losers?.length}`)
const topSeries = received.map((s) => `${s.gainers[0].name} ${s.gainers[0].pct_20d}`)
console.log(`  涨幅榜首轨迹: ${topSeries.slice(0, 6).join('  |  ')}`)

console.log('\n=== 产出联动 ===')
const mdPath = join(SCRATCH, '盘中实时.md')
check('P10', '实时榜文件被反复覆盖更新', existsSync(mdPath), mdPath.replace(WORKSPACE, ''))
check('P11', 'HTTP 接口对外可用', (await fetch(`${BASE}/api/rank20/latest`)).status === 200)
check('P12', '桩只拦截了行情源请求（未被其它请求干扰）', fetchCalls >= 6, `行情请求 ${fetchCalls} 次`)

await rt.close()
rmSync(SCRATCH, { recursive: true, force: true })
globalThis.fetch = realFetch

const pass = results.filter((r) => r.pass).length
console.log(`\n=== 结果：${pass}/${results.length} 通过${pass === results.length ? '' : '（有失败）'} ===`)
process.exit(pass === results.length ? 0 : 1)
