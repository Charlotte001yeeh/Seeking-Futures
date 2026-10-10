/**
 * realtime-server 验收测试（对应 docs/10 §8 的 V1–V12，可自动化部分）
 *
 * 刻意**不 spawn 子进程**（沙箱下管道 stdio 不可用），全部在同进程内：
 *   1) 纯函数单测：合约代码映射、基准日滚动
 *   2) 集成测试：真起 HTTP/SSE 服务，真打数据源，断言榜单/闸门/溯源/预留端点
 *
 * 用法：node test/verify.mjs
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SERVICE_ROOT = resolve(here, '..')
const WORKSPACE = resolve(SERVICE_ROOT, '..')

// ── 测试环境：与线上隔离（自己的端口 / 自己的数据目录）─────────────────
const TMP = join(SERVICE_ROOT, 'var-test')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
// 装载真实 K 线（官方日报 + 新浪历史）供 /kline 端点验证；只读复制，不改动原始数据
const REAL_KLINE = join(WORKSPACE, 'rank20', 'kline')
if (existsSync(REAL_KLINE)) {
  mkdirSync(join(TMP, 'kline'), { recursive: true })
  for (const f of readdirSync(REAL_KLINE)) {
    if (f.endsWith('.json')) writeFileSync(join(TMP, 'kline', f), readFileSync(join(REAL_KLINE, f)))
  }
}
process.env.RT_PORT = '8898'
process.env.RT_VAR = TMP
process.env.RT_OUT = TMP
process.env.RT_INTERVAL_MS = '1200'
process.env.RT_STORE_MS = '3000'

const results = []
const ok = (id, name, extra = '') => results.push({ id, name, pass: true, extra })
const bad = (id, name, extra = '') => results.push({ id, name, pass: false, extra })
function check(id, name, cond, extra = '') {
  cond ? ok(id, name, extra) : bad(id, name, extra)
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== 1. 纯函数单测 ===')

const { sinaSymbol, isMonthlyAvg } = await import('../src/sources/symbols.mjs')

check('U1', '郑商所 3 位月份 → 4 位', sinaSymbol('MA610') === 'nf_MA2610', `MA610 → ${sinaSymbol('MA610')}`)
check('U2', '郑商所 PTA', sinaSymbol('TA701') === 'nf_TA2701', `TA701 → ${sinaSymbol('TA701')}`)
check('U3', '上期所原样', sinaSymbol('rb2701') === 'nf_RB2701', `rb2701 → ${sinaSymbol('rb2701')}`)
check('U4', '能源中心原样', sinaSymbol('SC2611') === 'nf_SC2611')
check('U5', '中金所原样', sinaSymbol('IF2609') === 'nf_IF2609')
check('U6', '月均价合约无行情', sinaSymbol('PP2611F') === '' && isMonthlyAvg('PP2611F'))

// ── 源字段位：商品 44 段 vs 金融 50 段（回归守卫）────────────────────────
// 曾出过的 bug：金融段的时间/交易日被当成"源没有"而置空 →
// 8 个中金所品种 is_live=true 却没有 quote_time（溯源铁律 V8 缺失）。
const { parseQuote } = await import('../src/sources/sina.mjs')
const { fmtQuoteTime } = await import('../src/ranker.mjs')
{
  const comm = new Array(44).fill('0')
  comm[0] = '螺纹钢2701'
  comm[1] = '150431' // HHMMSS
  comm[6] = '3112'
  comm[10] = '3121'
  comm[17] = '2026-09-23'
  const c = parseQuote(comm)
  check('U6a', '商品段：时间取 [1]、交易日取 [17]', c?.time === '150431' && c?.tradeDay === '2026-09-23',
    `time=${c?.time} tradeDay=${c?.tradeDay}`)

  const fin = new Array(50).fill('0')
  fin[0] = '4485.000'
  fin[1] = '4490.400'
  fin[2] = '4457.200'
  fin[3] = '4461.800' // 最新价
  fin[9] = '4932.600' // 昨结
  fin[36] = '2026-09-23'
  fin[37] = '15:15:00' // 带冒号！
  fin[49] = '沪深300指数期货2612'
  const q = parseQuote(fin)
  check('U6b', '金融段：时间取 [37] 并归一化为 HHMMSS', q?.time === '151500', `time=${q?.time}`)
  check('U6c', '金融段：交易日取 [36]', q?.tradeDay === '2026-09-23', `tradeDay=${q?.tradeDay}`)
  check('U6d', '行情时间格式化接受两种源格式', fmtQuoteTime('151500') === '15:15:00' && fmtQuoteTime('15:15:00') === '15:15:00' && fmtQuoteTime('') === '')
}

const { BaseTable, BASE_OFFSET } = await import('../src/base.mjs')

// 构造 30 个交易日的假基准表
const dates = Array.from({ length: 30 }, (_, i) => `202608${String(i + 1).padStart(2, '0')}`)
const settles = Object.fromEntries(dates.map((d, i) => [d, 100 + i]))
const fakeDoc = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  tradeDate: dates[29],
  baseDate: dates[29 - BASE_OFFSET],
  tradingDates: dates,
  rows: [{ variety: 'xx', name: '测试', contract: 'XX2601', baseSettle: settles[dates[9]], baseDate: dates[9], settles }],
}
const bt = new BaseTable(fakeDoc, 0)

const noRoll = bt.resolveAnchor(dates[29])
check('U7', '未跨日 → 用官方基准', noRoll.baseDate === dates[9] && !noRoll.rolled, `baseDate=${noRoll.baseDate}`)

const rolled = bt.resolveAnchor('20260901')
check(
  'U8',
  '跨日 → 基准日前移一个交易日',
  rolled.rolled && rolled.baseDate === dates[10],
  `baseDate=${rolled.baseDate}（应为 ${dates[10]}）`,
)

// 缺结算价 → 前移
const sparse = { ...fakeDoc, rows: [{ ...fakeDoc.rows[0], settles: { ...settles, [dates[10]]: 0 } }] }
const bt2 = new BaseTable(sparse, 0)
const shifted = bt2.resolveAnchor('20260901')
check(
  'U9',
  'T−20 无结算价 → 回退到最近有结算价日',
  shifted.byVariety.get('xx').shifted && shifted.byVariety.get('xx').date === dates[9],
  `date=${shifted.byVariety.get('xx').date}`,
)

// 新挂牌（窗口内全无结算价）→ 标记 fallback
const bt3 = new BaseTable({ ...fakeDoc, rows: [{ ...fakeDoc.rows[0], settles: {} }] }, 0)
const fb = bt3.resolveAnchor('20260901').byVariety.get('xx')
check('U10', '新挂牌合约 → 退回官方基准并标记', fb.fallback === true && fb.settle === fakeDoc.rows[0].baseSettle)

// schema 校验：缺铁律字段应拒绝
const { loadBaseTable } = await import('../src/base.mjs')
const badPath = join(TMP, 'bad-base.json')
writeFileSync(badPath, JSON.stringify({ schemaVersion: 1, tradingDates: dates, rows: [{ variety: 'x' }] }))
let rejected = false
try { loadBaseTable(badPath) } catch { rejected = true }
check('U11', 'base.json 缺铁律字段 → 拒绝加载', rejected)

writeFileSync(badPath, JSON.stringify({ schemaVersion: 99, tradingDates: dates, rows: fakeDoc.rows }))
rejected = false
try { loadBaseTable(badPath) } catch { rejected = true }
check('U12', 'schemaVersion 不符 → 拒绝加载', rejected)

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== 2. 集成测试（真起服务 + 真打数据源）===')

const { config, inTradingWindow } = await import('../src/config.mjs')
const { SnapshotHub } = await import('../src/snapshot.mjs')
const { Store } = await import('../src/store.mjs')
const { BaseWatcher } = await import('../src/base.mjs')
const { Poller } = await import('../src/poller.mjs')
const { startServer } = await import('../src/server.mjs')

check('U13', '测试用输出目录已隔离', config.outDir === TMP && config.varDir === TMP, config.outDir)

const store = new Store()
const hub = new SnapshotHub()
const watcher = new BaseWatcher(config.baseFile)
const poller = new Poller(watcher, hub, store)
const server = await startServer({ poller, hub, baseWatcher: watcher })
poller.start()

const BASE = `http://127.0.0.1:${config.port}`
const getJson = async (p) => {
  const r = await fetch(BASE + p)
  return { status: r.status, body: await r.json().catch(() => null) }
}

/**
 * 等待首个快照。
 * 注意：轮询器启动时会先用**日报口径**播种一份快照（seq=1，liveCount=0），这样休市不空白。
 * 因此交易时段必须再多等一轮**真实换价**的快照，否则断言的是播种快照而不是实时快照。
 */
async function waitForSnapshot(timeoutMs = 30000) {
  const t0 = Date.now()
  let seeded = null
  while (Date.now() - t0 < timeoutMs) {
    const r = await getJson('/api/rank20/latest')
    if (r.status === 200 && r.body?.seq > 0) {
      if (r.body.liveCount > 0) return r.body
      seeded = seeded ?? r.body
      if (!inTradingWindow()) return r.body // 休市：播种快照就是最终口径
    }
    await new Promise((s) => setTimeout(s, 500))
  }
  return seeded
}

const snap = await waitForSnapshot()

check('V2a', '首份实时快照在 30s 内产生', !!snap, snap ? `seq=${snap.seq}` : '超时')

if (snap) {
  const base = watcher.table
  check('V2b', '榜单完整：涨幅 20 + 跌幅 20', snap.gainers.length === 20 && snap.losers.length === 20,
    `${snap.gainers.length}/${snap.losers.length}`)
  check('V2c', `品种总数 = 基准表品种数（${base.rows.length}）`, snap.all.length === base.rows.length,
    `${snap.all.length}/${base.rows.length}`)
  check('V2d', '0 静默丢失（missingAnchor = 0）', snap.missingAnchor === 0, `missingAnchor=${snap.missingAnchor}`)

  const total = snap.gainers[0].pct_20d
  const last = snap.losers[19].pct_20d
  check('V2e', '涨跌幅单调降序', total >= snap.gainers[19].pct_20d && snap.gainers[19].pct_20d >= snap.losers[0].pct_20d,
    `${total} … ${last}`)

  // V8 溯源
  const need = ['source', 'quote_time', 'is_live', 'base_settle', 'base_date', 'rolled_over']
  const missing = []
  for (const r of snap.all) for (const k of need) if (r[k] === undefined) missing.push(`${r.variety}.${k}`)
  check('V8', '每行溯源字段齐备（铁律）', missing.length === 0, missing.slice(0, 5).join(',') || `检查 ${snap.all.length} 行`)

  // 换价行必须带**非空且格式正确**的行情时间（金融品种曾整段缺失）
  const liveRows = snap.all.filter((r) => r.is_live)
  const noTime = liveRows.filter((r) => !/^\d{2}:\d{2}:\d{2}$/.test(String(r.quote_time ?? '')))
  check('V8c', `每个换价行都有合法的 quote_time（${liveRows.length} 行）`, noTime.length === 0,
    noTime.map((r) => `${r.variety}=${JSON.stringify(r.quote_time)}`).join(' ') || '全部 HH:MM:SS')
  const finRows = liveRows.filter((r) => r.isFin)
  check('V8d', `金融品种也有 quote_time（${finRows.length} 行）`, finRows.length === 0 || finRows.every((r) => /^\d{2}:\d{2}:\d{2}$/.test(String(r.quote_time))),
    finRows.map((r) => `${r.variety}=${r.quote_time}`).join(' '))

  const badBase = snap.all.filter((r) => !(r.base_settle > 0) || !r.base_date)
  check('V8b', '每行都有有效基准价与基准日', badBase.length === 0, badBase.map((r) => r.variety).join(','))

  // V7 非实时标的必须显式标记
  const f = base.rows.filter((r) => r.isMonthlyAvg).map((r) => r.variety)
  const fRows = snap.all.filter((r) => f.includes(r.variety))
  check('V7', `月均价合约（${f.length} 个）标记为非实时`, fRows.length > 0 && fRows.every((r) => r.is_live === false && r.source === 'daily_snapshot'),
    `live=${snap.liveCount}/${snap.total}`)

  // 覆盖率断言要看是否在交易时段：休市时轮询器按设计不发请求，
  // 此时应表现为"全量日报口径"，而不是硬套 90%。
  if (inTradingWindow()) {
    check('V2f', '交易时段：实时覆盖率 ≥ 90%（源可用）', snap.liveCount / snap.total >= 0.9,
      `${snap.liveCount}/${snap.total} = ${((snap.liveCount / snap.total) * 100).toFixed(1)}%`)
  } else {
    const allDaily = snap.all.every((r) => r.is_live === false && r.source === 'daily_snapshot')
    check('V2f', '休市：全量为日报口径且明确标记非实时', snap.liveCount === 0 && allDaily,
      `换价=${snap.liveCount}/${snap.total}`)
  }
}

// V3 流量闸门
const health = await getJson('/api/health')
check('V3a', '/api/health 可用', health.status === 200 && health.body?.ok === true)
if (health.status === 200) {
  const g = health.body.poller.gate
  const lim = g.limits
  check('V3b', `≤ ${lim.maxReqPerSec} req/s（实测 ${g.reqLastSec}）`, g.reqLastSec <= lim.maxReqPerSec)
  check('V3c', `≤ ${lim.maxReqPerMin} req/min（实测 ${g.reqLastMin}）`, g.reqLastMin <= lim.maxReqPerMin)
  check('V3d', `≤ ${lim.maxReqPerDay} req/日（实测 ${g.reqToday}）`, g.reqToday <= lim.maxReqPerDay)
  check('V3e', '节拍在配置范围内', health.body.poller.intervalMs >= config.poll.intervalMs,
    `intervalMs=${health.body.poller.intervalMs}`)
  check('V5b', '数据源健康为 ok', health.body.poller.source.state === 'ok',
    `state=${health.body.poller.source.state} ok=${health.body.poller.source.ok} err=${health.body.poller.source.err}`)
}

// 预留端点已落地为**真实实现**（D3 日K线 / D4 硬逻辑）
const kline = await getJson('/api/variety/sc/kline?days=60')
check('V11', '日K线端点返回真实数据（原 501 占位已落地）',
  kline.status === 200 && Array.isArray(kline.body?.bars) && kline.body.bars.length > 0,
  `${kline.body?.bars?.length ?? 0} 根，来源 ${JSON.stringify(kline.body?.sourceBreakdown ?? {})}`)
const logic = await getJson('/api/variety/sc/logic')
check('V12', '硬逻辑端点返回规则推导（原 501 占位已落地）',
  logic.status === 200 && logic.body?.generatedBy === 'rules-v1' && Array.isArray(logic.body?.evidence),
  `${logic.body?.directionCN ?? '?'} / ${logic.body?.sector ?? '?'} / 证据 ${logic.body?.evidence?.length ?? 0} 条`)

// 静态资源
const page = await fetch(BASE + '/')
const html = await page.text()
check('V4a', '首页可访问', page.status === 200 && html.includes('涨幅榜'))
for (const asset of ['/app.js', '/style.css']) {
  const r = await fetch(BASE + asset)
  check('V4b', `静态资源 ${asset}`, r.status === 200)
}

// SSE：hello → snapshot → heartbeat
async function readSSE(timeoutMs = 8000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  const events = []
  try {
    const res = await fetch(BASE + '/events', { signal: ctl.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (events.length < 3) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const ev = /^event: (\w+)/m.exec(chunk)
        const da = /^data: (.*)$/m.exec(chunk)
        if (ev && da) events.push({ type: ev[1], data: JSON.parse(da[1]) })
      }
    }
    ctl.abort()
  } catch { /* abort 是正常的收尾 */ }
  clearTimeout(t)
  return events
}

const events = await readSSE()
const hello = events.find((e) => e.type === 'hello')
const sseSnap = events.find((e) => e.type === 'snapshot')
check('V1a', 'SSE 收到 hello', !!hello && hello.data.protocolVersion === 1)
check('V1b', 'SSE 收到 snapshot（首屏不空等）', !!sseSnap && sseSnap.data.gainers.length === 20,
  sseSnap ? `seq=${sseSnap.data.seq}` : '未收到')
check('V1c', 'snapshot 载荷含行情时间与换价统计',
  !!sseSnap && 'quoteTime' in sseSnap.data && 'liveCount' in sseSnap.data && 'seq' in sseSnap.data)

// 节流落库
poller.store.persist(snap, { force: true, tag: 'test' })
const jsonl = join(TMP, `intraday-${snap.tradeDate}.jsonl`)
check('V9', '盘中快照已落库（JSONL，节流）', existsSync(jsonl) && readFileSync(jsonl, 'utf8').trim().split('\n').length >= 1)

// 产物文件
check('V10', '人看的产物已写出（盘中实时.md / .csv）',
  existsSync(join(TMP, `${config.rtName}.md`)) && existsSync(join(TMP, `${config.rtName}.csv`)))

// 降级演练：把基准表指向不存在的文件 → 服务不崩、健康接口暴露错误
const watcher2 = new BaseWatcher(join(TMP, 'nope.json'))
watcher2.refresh()
check('V6', '基准表缺失 → 不崩溃且暴露 lastError', !!watcher2.lastError && watcher2.table === null, watcher2.lastError ?? '')

// 稳定性：交易时段内 seq 必须递增；休市时段轮询器按设计停摆（60s 醒一次），
// 此时应表现为 state=closed 且 seq 不增长 —— 而不是判失败。
const seqBefore = hub.seq
await new Promise((s) => setTimeout(s, 4000))
if (inTradingWindow()) {
  check('V5a', '交易时段：持续轮询 seq 递增', hub.seq > seqBefore, `${seqBefore} → ${hub.seq}`)
} else {
  const st = (await getJson('/api/health')).body?.poller?.state
  check('V5a', '休市：轮询停摆且状态为 closed（不空转请求）', st === 'closed' && hub.seq === seqBefore, `state=${st} seq=${hub.seq}`)
}
const h2 = await getJson('/api/health')
check('V5c', `轮询无未捕获异常（err=${h2.body?.poller?.source?.err ?? '?'}）`, (h2.body?.poller?.source?.err ?? 1) < 5)

poller.stop()
server.close()

// ══════════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.pass).length
const fail = results.length - pass
console.log(`\n=== 结果：${pass}/${results.length} 通过${fail ? `，${fail} 失败` : ''} ===`)
if (fail) {
  console.log('失败项：')
  for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.id} ${r.name} ${r.extra}`)
}
process.exit(fail ? 1 : 0)
