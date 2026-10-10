/**
 * 一键体检：对**正在运行的** rank20 前后端做全链路只读检查
 *
 * 检查项：
 *   1 进程/端口/静态资源（前端三件套是否可拿到，且是当前版本）
 *   2 /api/health（轮询器状态、节拍、闸门计数、订阅者）
 *   3 SSE /events（hello → snapshot → heartbeat 事件流是否真的在推）
 *   4 /api/rank20/latest（榜单完整性、实时覆盖率、口径字段）
 *   5 展开面板两个端点：/api/variety/:v/kline、/api/variety/:v/logic
 *   6 /api/sources（7 源 + 本地产物）、/api/model/config（只回掩码）
 *   7 交易时段判定 + 数据新鲜度（行情时间 vs 本地时间）
 *
 * 用法：node test/status.mjs [port]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RT = resolve(HERE, '..')
const PORT = Number(process.argv[2] ?? 8899)
const B = `http://127.0.0.1:${PORT}`
const { inTradingWindow } = await import('../src/config.mjs')
const TRADING = inTradingWindow()

const line = (s = '') => console.log(s)
const ok = (b) => (b ? '✓' : '✗')
const ms = (n) => `${String(n).padStart(6)}ms`

async function j(path, opt) {
  const t0 = Date.now()
  try {
    const r = await fetch(B + path, opt)
    const txt = await r.text()
    let body = null
    try { body = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body, txt, ms: Date.now() - t0, headers: r.headers }
  } catch (e) {
    return { status: 0, body: null, txt: String(e), ms: Date.now() - t0, error: e }
  }
}

line(`════════ rank20 运行体检   ${new Date().toLocaleString('zh-CN')}   ${B} ════════`)

// ── 1 静态资源 ────────────────────────────────────────────────────────────
line('\n【1】前端静态资源')
const local = {
  'index.html': readFileSync(join(RT, 'web', 'index.html')),
  'app.js': readFileSync(join(RT, 'web', 'app.js')),
  'style.css': readFileSync(join(RT, 'web', 'style.css')),
}
let assetsOk = true
for (const [name, buf] of Object.entries(local)) {
  const r = await j(`/${name}`)
  const same = r.status === 200 && r.txt.length > 0 && Buffer.byteLength(r.txt) > 0
  // 内容一致性：字节数对比（服务端读的就是同一文件）
  const servedLen = r.status === 200 ? Buffer.byteLength(r.txt, 'utf8') : 0
  const diskLen = buf.length
  const match = servedLen === diskLen ? '内容与磁盘一致' : `⚠ 长度不一致 服务端${servedLen} / 磁盘${diskLen}`
  if (!same || servedLen !== diskLen) assetsOk = false
  line(`  ${ok(same && servedLen === diskLen)} ${name.padEnd(11)} HTTP ${r.status}  ${ms(r.ms)}  ${(diskLen / 1024).toFixed(1)}KB  ${match}`)
}
const html = local['index.html'].toString('utf8')
const js = local['app.js'].toString('utf8')
line(`  ${ok(/id="ops"/.test(html))} 运行状态模块在页面里（榜单下方）`)
line(`  ${ok(/function loadSources/.test(js) && /function testModelConn/.test(js))} 前端已接线源检测 / 模型连通性测试`)

// ── 2 /api/health ─────────────────────────────────────────────────────────
line('\n【2】服务与轮询器 /api/health')
const h = await j('/api/health')
if (!h.body) {
  line(`  ✗ 无法访问：${h.txt}`)
  process.exit(1)
}
const p = h.body.poller ?? {}
line(`  ${ok(h.body.ok)} ok=${h.body.ok}  运行时长 ${(h.body.uptimeMs / 3600000).toFixed(1)} 小时  ${ms(h.ms)}`)
line(`  轮询器 state=${p.state}  cycles=${p.cycles}  idleRounds=${p.idleRounds}  节拍=${p.intervalMs}ms`)
line(`  订阅者=${p.subscribers}  推送=${p.pushes}  丢弃=${p.dropped}`)
if (p.gate) {
  const g = p.gate
  line(`  闸门 1s=${g.reqLastSec}/${g.limits.maxReqPerSec}  1min=${g.reqLastMin}/${g.limits.maxReqPerMin}  今日=${g.reqToday}/${g.limits.maxReqPerDay}  被拦=${g.blockedCount}`)
}
line(`  数据源级联 source=${p.source?.source} state=${p.source?.state}  成功=${p.source?.ok} 失败=${p.source?.err}（${((p.source?.errRate ?? 0) * 100).toFixed(2)}%）  p50=${p.source?.p50LatencyMs}ms  backoff=${p.source?.backoffMs}ms`)
line(`  最近成功=${p.source?.lastOkAt ? new Date(p.source.lastOkAt).toLocaleTimeString('zh-CN') : '—'}${p.source?.lastError ? `  最近错误=${p.source.lastError}` : ''}`)
const bs = h.body.base ?? {}
line(`  基准表：交易日 ${bs.tradeDate}  基准日 ${bs.baseDate}  ${bs.varieties} 个品种  生成于 ${bs.generatedAt ? new Date(bs.generatedAt).toLocaleString('zh-CN') : '—'}`)

// ── 3 SSE ────────────────────────────────────────────────────────────────
line('\n【3】SSE 推送 /events')
{
  const { config } = await import('../src/config.mjs')
  const ev = []
  const ctl = new AbortController()
  const WIN = Math.max(6000, config.heartbeatMs + 6000) // 心跳周期 + 余量
  const t = setTimeout(() => ctl.abort(), WIN)
  try {
    const r = await fetch(`${B}/events`, { signal: ctl.signal })
    line(`  ${ok(r.status === 200 && /event-stream/.test(r.headers.get('content-type') ?? ''))} HTTP ${r.status}  Content-Type: ${r.headers.get('content-type')}`)
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const t0 = Date.now()
    while (Date.now() - t0 < WIN) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const m = /^event: (\w+)/m.exec(chunk)
        if (m) ev.push({ name: m[1], at: Date.now() - t0 })
      }
      if (ev.filter((e) => e.name === 'snapshot').length >= 3 && ev.some((e) => e.name === 'heartbeat')) break
    }
    reader.cancel().catch(() => {})
  } catch {
    /* abort 收尾 */
  } finally {
    clearTimeout(t)
  }
  line(`  观察窗口 ${(WIN / 1000).toFixed(0)}s（心跳周期 ${config.heartbeatMs}ms）`)
  line(`  ${ok(ev.length > 0)} 事件序列：${ev.map((e) => `${e.name}@${(e.at / 1000).toFixed(1)}s`).join(' → ') || '（未收到）'}`)
  const snapEv = ev.filter((e) => e.name === 'snapshot')
  const hb = ev.filter((e) => e.name === 'heartbeat')
  line(`  ${ok(ev.some((e) => e.name === 'hello'))} hello 握手   ${ok(snapEv.length > 0)} snapshot ${snapEv.length} 次   ${ok(hb.length > 0)} heartbeat ${hb.length} 次`)
  if (snapEv.length >= 2) line(`  榜单推送间隔：${snapEv[1].at - snapEv[0].at}ms`)
  if (hb.length >= 1) line(`  心跳间隔：${hb[0].at}ms（首个）`)
}

// ── 4 榜单 ───────────────────────────────────────────────────────────────
line('\n【4】榜单 /api/rank20/latest')
const s = await j('/api/rank20/latest')
const snap = s.body
if (!snap || !snap.seq) {
  line(`  ✗ 无快照（seq=${snap?.seq}）`)
} else {
  line(`  ${ok(snap.gainers?.length === 20 && snap.losers?.length === 20)} seq=${snap.seq}  涨 ${snap.gainers?.length} / 跌 ${snap.losers?.length}  品种总数 ${snap.all?.length}`)
  line(`  交易日 ${snap.tradeDate}  基准日 ${snap.baseDate}  行情时间 ${snap.quoteTime}  服务端时间 ${new Date(snap.serverTime).toLocaleTimeString('zh-CN')}`)
  line(`  换价 ${snap.liveCount}/${snap.total}（${((snap.liveCount / snap.total) * 100).toFixed(1)}%）  静默丢失 missingAnchor=${snap.missingAnchor}`)
  const top = snap.gainers?.[0]
  const bot = snap.losers?.[snap.losers.length - 1]
  if (top) line(`  涨幅榜首 ${top.name} ${top.contract} ${top.pct_20d > 0 ? '+' : ''}${top.pct_20d}%  (基准 ${top.base_settle} @ ${top.base_date}，来源 ${top.source}，实时=${top.is_live})`)
  if (bot) line(`  跌幅榜首 ${bot.name} ${bot.contract} ${bot.pct_20d}%  (基准 ${bot.base_settle} @ ${bot.base_date}，来源 ${bot.source}，实时=${bot.is_live})`)
  const srcCount = {}
  for (const r of snap.all ?? []) srcCount[r.source] = (srcCount[r.source] ?? 0) + 1
  line(`  来源分布：${Object.entries(srcCount).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  const liveRows = (snap.all ?? []).filter((r) => r.is_live)
  const noTime = liveRows.filter((r) => !/^\d{2}:\d{2}:\d{2}$/.test(String(r.quote_time ?? '')))
  line(`  ${ok(noTime.length === 0)} 每个换价行都有合法行情时间（${liveRows.length} 行，含金融 ${liveRows.filter((r) => r.isFin).length} 行）${noTime.length ? ' 缺失：' + noTime.map((r) => r.variety).join(',') : ''}`)
  // 各行时间本来就可以不同（冷门合约成交稀疏、中金所 15:15 收盘、休市后各自冻结在最后一笔）。
  // 因此只在**盘中**对"离全局最新时间过久"报警；休市后仅如实展示分布。
  const times = [...new Set(liveRows.map((r) => r.quote_time))].filter(Boolean).sort()
  const toSec = (t) => Number(String(t).replace(/:/g, ''))
  const spread = times.length ? toSec(times.at(-1)) - toSec(times[0]) : 0
  if (TRADING) {
    line(`  ${ok(spread <= 900)} 行情时间跨度 ${spread}s（盘中允许 ≤900s，冷门/中金所各自更慢）  最早 ${times[0] ?? '—'} 最新 ${times.at(-1) ?? '—'}`)
  } else {
    line(`  · 休市：各行冻结在各自最后一笔（${times[0] ?? '—'} ~ ${times.at(-1) ?? '—'}，跨度 ${spread}s）—— 非异常`)
  }
}

// ── 5 展开面板端点 ───────────────────────────────────────────────────────
line('\n【5】展开面板端点（以 rb 为例）')
const k = await j('/api/variety/rb/kline')
if (k.body?.bars?.length) {
  const b = k.body.bars
  const srcCount = {}
  for (const x of b) srcCount[x.src] = (srcCount[x.src] ?? 0) + 1
  const last = b[b.length - 1]
  line(`  ${ok(b.length > 0)} /api/variety/rb/kline  ${b.length} 根  ${ms(k.ms)}  来源 ${Object.entries(srcCount).map(([a, c]) => `${a}=${c}`).join(' ')}`)
  line(`  合约 ${k.body.contract}  官方起点 ${k.body.officialFrom}  实时根日期 ${k.body.liveBarDate}  isLive=${k.body.isLive}  换月标记 ${k.body.rollovers?.length ?? 0} 条`)
  line(`  末根 ${last.d}  开 ${last.o} 高 ${last.h} 低 ${last.l} 收 ${last.c} 结算 ${last.s || '—（盘中未结算）'} 量 ${last.v} 仓 ${last.oi}  src=${last.src}`)
  const complete = b.filter((x) => !x.d || !(x.c >= 0))
  const withOhl = b.filter((x) => x.o !== undefined && x.h !== undefined && x.l !== undefined)
  line(`  ${ok(complete.length === 0)} 每根都有 日期+收盘（缺 ${complete.length} 根）   ${ok(withOhl.length === b.length)} 每根都有 开高低（${withOhl.length}/${b.length}）`)
} else {
  line(`  ✗ /api/variety/rb/kline → HTTP ${k.status} ${k.txt.slice(0, 120)}`)
}
const lg = await j('/api/variety/rb/logic')
if (lg.body?.evidence) {
  line(`  ${ok(true)} /api/variety/rb/logic  ${ms(lg.ms)}  方向=${lg.body.directionCN}  生成方式=${lg.body.generatedBy}  模型已接入=${lg.body.modelConnected}  证据 ${lg.body.evidence.length} 条`)
} else {
  line(`  ✗ /api/variety/rb/logic → HTTP ${lg.status} ${lg.txt.slice(0, 120)}`)
}
// 品种数对账：快照 vs 基准表
{
  const basePath = join(RT, '..', 'rank20', 'base.json')
  try {
    const base = JSON.parse(readFileSync(basePath, 'utf8'))
    const same = base.rows.length === (snap?.all?.length ?? -1)
    line(`  ${ok(same)} 品种数对账：基准表 ${base.rows.length} 行 vs 榜单 ${snap?.all?.length} 行`)
    const inBase = new Set(base.rows.map((r) => r.variety))
    const missing = (snap?.all ?? []).map((r) => r.variety).filter((v) => !inBase.has(v))
    line(`  ${ok(missing.length === 0)} 榜单品种都在基准表内（多出 ${missing.length} 个${missing.length ? '：' + missing.join(',') : ''}）`)
  } catch (e) {
    line(`  · 基准表读取失败：${e.message}`)
  }
}

// ── 6 运行状态模块的两个端点 ──────────────────────────────────────────────
line('\n【6】运行状态模块')
const so = await j('/api/sources')
if (so.body?.sources) {
  line(`  ${ok(so.body.okCount === so.body.total)} /api/sources  ${so.body.okCount}/${so.body.total} 可用  ${ms(so.ms)}  cached=${so.body.cached}  探测耗时=${so.body.elapsedMs}ms`)
  for (const x of so.body.sources) line(`     ${ok(x.ok)} ${x.name.padEnd(14)} ${String(x.latencyMs).padStart(6)}ms  ${x.detail ?? x.error ?? ''}`)
  for (const x of so.body.local ?? []) line(`     ${ok(x.ok)} ${x.name.padEnd(20)} ${x.detail}`)
} else {
  line(`  ✗ /api/sources → HTTP ${so.status} ${so.txt.slice(0, 120)}`)
}
const mc = await j('/api/model/config')
line(`  ${ok(mc.status === 200 && !('apiKey' in (mc.body ?? {})))} /api/model/config  已配置=${mc.body?.hasKey}  掩码=${mc.body?.keyMasked || '(无)'}  地址=${mc.body?.baseUrl || '(空)'}  模型=${mc.body?.model || '(空)'}`)
line(`  ${ok(!('apiKey' in (mc.body ?? {})))} 响应体不含明文 Key 字段`)
const mt = await j('/api/model/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
line(`  ${mt.body?.ok ? '✓' : '·'} /api/model/test（当前配置）  ok=${mt.body?.ok}  ${mt.body?.ok ? `${mt.body.via} HTTP ${mt.body.status} ${mt.body.latencyMs}ms` : mt.body?.error}`)

// ── 7 时段与新鲜度 ───────────────────────────────────────────────────────
line('\n【7】交易时段 / 数据新鲜度 / 每日任务')
const trading = TRADING
line(`  inTradingWindow() = ${trading}（本地 ${new Date().toLocaleString('zh-CN')}）`)
if (snap?.quoteTime) line(`  行情时间 ${snap.quoteTime}（交易日字段 ${snap.tradeDate}）→ 与本地相差 ${Math.abs(Date.now() - new Date(snap.serverTime).getTime())}ms 级（服务端打点）`)
line(`  轮询器 state=${p.state}${p.state === 'closed' ? '（休市：按设计零请求，榜单为日报口径 + 横幅标注）' : '（盘中：按节拍轮询）'}`)

// 每日 09:00 任务的产物
{
  const dir = join(RT, '..', 'rank20')
  const files = readdirSync(dir).filter((f) => /^\d{4}年\d{2}月\d{2}日\d{2}时\.(md|csv)$/.test(f))
  const byStamp = {}
  for (const f of files) {
    const stamp = f.slice(0, f.indexOf('.'))
    ;(byStamp[stamp] ??= []).push(f.endsWith('.csv') ? 'csv' : 'md')
  }
  const stamps = Object.keys(byStamp).sort()
  line(`  每日任务产物：${stamps.length} 组（${stamps.slice(0, 3).join(' / ')}${stamps.length > 3 ? ' … ' : ''}${stamps.at(-1)})`)
  const latest = stamps.at(-1)
  line(`  ${ok(latest && byStamp[latest].includes('md') && byStamp[latest].includes('csv'))} 最近一组 ${latest}：md+csv ${latest ? (byStamp[latest].includes('md') && byStamp[latest].includes('csv') ? '齐全' : '缺文件') : ''}`)
  const latestMd = join(dir, 'latest.md')
  const st = statSync(latestMd)
  line(`  latest.md 更新于 ${st.mtime.toLocaleString('zh-CN')}`)
}
line('  服务日志：realtime-server/var/server.log')
line('')
