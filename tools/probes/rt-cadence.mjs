/**
 * 实时行情「最大更新频率」实测器
 *
 * 做法：以固定间隔高频轮询新浪实时行情，逐合约记录「值发生变化」的时刻，
 *       从而得出该源实际的数据刷新节拍（最小变化间隔 / 中位间隔 / 分布）。
 *
 * 用法：
 *   node tools/probes/rt-cadence.mjs --wait 21:00 --minutes 30 --poll 250
 *   node tools/probes/rt-cadence.mjs --minutes 1 --poll 250          # 立即跑（收盘时段用于自检）
 *
 * 产物：tools/probes/out/rt-cadence-<时间戳>.json  +  rt-cadence-<时间戳>.md
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(root, { recursive: true })
const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
}

const WAIT = opt('wait', '')            // "21:00" 等到该时刻再开始
const MINUTES = Number(opt('minutes', 30))
const POLL = Number(opt('poll', 250))   // 轮询间隔 ms
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
/**
 * 采样合约：覆盖六所 + 流动性高低两档
 *   注意：CZCE 在新浪用 **4 位月份**（官方代码 MA610 → 新浪 MA2610）
 * 可用 --symbols nf_RB2701,nf_SC2611 覆盖（高频探底时只取 1-2 个，降低对方压力）
 */
const DEFAULT_SYMBOLS = [
  'nf_RB2701',  // SHFE 螺纹钢（最活跃之一）
  'nf_CU2610',  // SHFE 沪铜
  'nf_AU2610',  // SHFE 沪金
  'nf_SC2611',  // INE  原油
  'nf_EC2610',  // INE  集运指数（欧线）
  'nf_MA2610',  // CZCE 甲醇（4 位月份）
  'nf_TA2701',  // CZCE PTA（4 位月份）
  'nf_M2701',   // DCE  豆粕
  'nf_PP2701',  // DCE  聚丙烯
  'nf_I2701',   // DCE  铁矿石
  'nf_SI2611',  // GFEX 工业硅
  'nf_LC2701',  // GFEX 碳酸锂
  'nf_PT2612',  // GFEX 铂（低流动性对照）
  'nf_IF2609',  // CFFEX 沪深300
  'nf_T2612',   // CFFEX 10年期国债
]
const SYMBOLS = opt('symbols', '')
  ? opt('symbols', '').split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SYMBOLS

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析新浪返回（GB18030）→ { SYMBOL: [字段...] } */
async function poll() {
  const url = `https://hq.sinajs.cn/list=${SYMBOLS.join(',')}`
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 5000)
  try {
    const res = await fetch(url, {
      headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': UA },
      signal: ctl.signal,
    })
    const text = new TextDecoder('gb18030').decode(Buffer.from(await res.arrayBuffer()))
    const out = {}
    for (const line of text.split('\n')) {
      const m = /var hq_str_([A-Za-z0-9_]+)="([^"]*)"/.exec(line)
      if (m && m[2]) out[m[1]] = m[2].split(',')
    }
    return out
  } finally {
    clearTimeout(t)
  }
}

/** 取决定"行情是否更新"的关键字段（商品 44 段 / 金融 50 段，字段位不同） */
function signature(f) {
  if (!f) return null
  const isFin = f.length >= 50
  // 商品：最新价[6] 持仓[13] 成交量[14] 源时间戳[1]
  // 金融：最新价[3] 持仓[6]? 成交量[4] 源时间戳（无）
  return isFin
    ? `${f[3]}|${f[4]}|${f[6]}`
    : `${f[6]}|${f[13]}|${f[14]}|${f[1]}`
}

function median(a) {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ── 等待到指定时刻 ──
if (WAIT) {
  const [hh, mm] = WAIT.split(':').map(Number)
  for (;;) {
    const now = new Date()
    const target = new Date(now)
    target.setHours(hh, mm, 0, 0)
    if (target.getTime() <= now.getTime()) break
    const d = target.getTime() - now.getTime()
    console.log(`[${now.toLocaleTimeString('zh-CN')}] 等待至 ${WAIT}（还有 ${(d / 60000).toFixed(1)} 分钟）`)
    await sleep(Math.min(d, 60000))
  }
  console.log(`到达 ${WAIT}，开始采样`)
}

// ── 采样 ──
const state = {}
for (const s of SYMBOLS) state[s] = { sig: null, changes: [], stamps: new Set(), samples: 0, errors: 0, first: null, last: null }

const t0 = Date.now()
const endAt = t0 + MINUTES * 60000
let cycles = 0
let lastProgress = 0

console.log(`开始采样：${MINUTES} 分钟，轮询间隔 ${POLL}ms，${SYMBOLS.length} 个合约`)

while (Date.now() < endAt) {
  const wall = Date.now()
  let data
  try {
    data = await poll()
  } catch (e) {
    for (const s of SYMBOLS) state[s].errors++
    await sleep(POLL)
    continue
  }
  cycles++
  for (const s of SYMBOLS) {
    const st = state[s]
    const f = data[s]
    st.samples++
    if (!f) continue
    if (!st.first) st.first = f.slice()
    st.last = f.slice()
    const sig = signature(f)
    if (st.sig === null) {
      st.sig = sig
      continue
    }
    if (sig !== st.sig) {
      st.changes.push(wall)
      st.sig = sig
      if (!f.length || f.length < 50) st.stamps.add(f[1])
    }
  }
  if (wall - lastProgress > 30000) {
    lastProgress = wall
    const pct = (((wall - t0) / (endAt - t0)) * 100).toFixed(0)
    const totalChanges = SYMBOLS.reduce((a, s) => a + state[s].changes.length, 0)
    console.log(`  ${pct}%  轮询 ${cycles} 次  观察到变化 ${totalChanges} 次`)
  }
  const spent = Date.now() - wall
  if (spent < POLL) await sleep(POLL - spent)
}

// ── 汇总 ──
const report = { pollMs: POLL, minutes: MINUTES, startedAt: new Date(t0).toISOString(), cycles, symbols: {} }
const lines = []
lines.push(`# 新浪实时行情更新频率实测`)
lines.push('')
lines.push(`- 采样窗口：${new Date(t0).toLocaleString('zh-CN')} 起 ${MINUTES} 分钟`)
lines.push(`- 轮询间隔：${POLL}ms，实际完成 ${cycles} 次轮询`)
lines.push('')
lines.push('| 合约 | 交易所 | 观察到的变化次数 | 最小间隔(ms) | 中位间隔(ms) | 最大间隔(ms) | 源时间戳样例 | 错误 |')
lines.push('| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |')

const EX = { RB: 'SHFE', CU: 'SHFE', AU: 'SHFE', SC: 'INE', EC: 'INE', MA: 'CZCE', TA: 'CZCE', M: 'DCE', PP: 'DCE', I: 'DCE', SI: 'GFEX', LC: 'GFEX', PT: 'GFEX', IF: 'CFFEX', T: 'CFFEX' }

for (const s of SYMBOLS) {
  const st = state[s]
  const d = []
  for (let i = 1; i < st.changes.length; i++) d.push(st.changes[i] - st.changes[i - 1])
  const code = s.replace('nf_', '')
  const stamps = [...st.stamps].slice(0, 6).join(' ')
  report.symbols[s] = {
    changes: st.changes.length,
    deltas: d,
    minMs: d.length ? Math.min(...d) : null,
    medianMs: d.length ? median(d) : null,
    maxMs: d.length ? Math.max(...d) : null,
    samples: st.samples,
    errors: st.errors,
    stamps: [...st.stamps],
    firstQuote: st.first,
    lastQuote: st.last,
  }
  lines.push(
    `| ${code} | ${EX[code.replace(/\d.*/, '')] ?? '?'} | ${st.changes.length} | ${d.length ? Math.min(...d) : '—'} | ${d.length ? median(d) : '—'} | ${d.length ? Math.max(...d) : '—'} | ${stamps || '—'} | ${st.errors} |`,
  )
}

const allDeltas = SYMBOLS.flatMap((s) => {
  const st = state[s]
  const d = []
  for (let i = 1; i < st.changes.length; i++) d.push(st.changes[i] - st.changes[i - 1])
  return d
})

lines.push('')
lines.push(`## 总体`)
lines.push('')
if (allDeltas.length) {
  lines.push(`- 全合约合计观察到 ${allDeltas.length} 次值变化`)
  lines.push(`- **最小变化间隔：${Math.min(...allDeltas)}ms**`)
  lines.push(`- 中位变化间隔：${median(allDeltas)}ms`)
  lines.push(`- 最大变化间隔：${Math.max(...allDeltas)}ms`)
  const hist = {}
  for (const d of allDeltas) {
    const bucket = d < 300 ? '<300' : d < 600 ? '300-600' : d < 1100 ? '600-1100' : d < 2100 ? '1100-2100' : d < 5100 ? '2100-5100' : '>5100'
    hist[bucket] = (hist[bucket] ?? 0) + 1
  }
  lines.push(`- 间隔分布：${Object.entries(hist).map(([k, v]) => `${k}ms → ${v}次`).join('，')}`)
} else {
  lines.push('- ⚠️ 整个窗口内没有任何值变化 —— 说明采样时市场未开市（收盘/休市），需要重跑在交易时段。')
}
lines.push('')

const stamp = new Date(t0).toISOString().replace(/[:.]/g, '-').slice(0, 19)
writeFileSync(join(root, `rt-cadence-${stamp}.json`), JSON.stringify(report, null, 2), 'utf8')
writeFileSync(join(root, `rt-cadence-${stamp}.md`), lines.join('\n'), 'utf8')
console.log('\n' + lines.join('\n'))
console.log(`\n已写出 rt-cadence-${stamp}.json / .md`)
