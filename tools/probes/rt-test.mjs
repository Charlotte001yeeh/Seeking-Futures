/**
 * 盘中实时逻辑自检：日报基准 + 新浪实时最新价 → 实时榜
 * 用法：node tools/probes/rt-test.mjs [lookbackDays]
 */
import { fetchAllExchanges } from '../../rank20-daemon/dist/exchanges.js'
import { computeRank20 } from '../../rank20-daemon/dist/rank20.js'
import { fetchLiveQuotes, sinaSymbol, inTradingWindow } from '../../rank20-daemon/dist/realtime.js'

const days = Number(process.argv[2] ?? 32)
console.log(`是否在交易时段：${inTradingWindow()}`)

const map = await fetchAllExchanges(days, () => {})
const base = computeRank20(map)
console.log(`日报：交易日=${base.tradeDate} 基准日=${base.baseDate} 品种=${base.all.length}`)

console.log('\n=== 合约 → 新浪代码 映射抽样 ===')
const sample = base.all.filter((r) =>
  ['sc', 'ma', 'ta', 'rb', 'm', 'si', 'if', 't', 'ppF', 'pl', 'sh', 'ap'].includes(r.variety),
)
for (const r of sample) console.log(`  ${r.name.padEnd(14)} ${r.contract.padEnd(9)} → ${sinaSymbol(r.contract) || '(无)'}`)

const t0 = Date.now()
const quotes = await fetchLiveQuotes(base.all.map((r) => r.contract))
console.log(`\n实时取价：${quotes.size}/${base.all.length} 个合约命中，用时 ${Date.now() - t0}ms`)

const missing = base.all.filter((r) => !quotes.has(r.contract.toUpperCase()))
console.log(`未命中 ${missing.length} 个：${missing.map((r) => `${r.name}/${r.contract}`).join('、') || '无'}`)

const rows = base.all.map((r) => {
  const q = quotes.get(r.contract.toUpperCase())
  if (!q) return r
  return { ...r, close: q.price, pct: ((q.price - r.baseSettle) / r.baseSettle) * 100 }
})
rows.sort((a, b) => b.pct - a.pct)

const q0 = [...quotes.values()].find((q) => q.time)
console.log(`\n行情时间：${q0?.time ?? '-'}  交易日标注：${q0?.tradeDay ?? '-'}`)
console.log(`\n=== 实时涨幅榜前 20（对比日报值）===`)
rows.slice(0, 20).forEach((r, i) => {
  const d = base.all.find((x) => x.variety === r.variety)
  const delta = d ? r.pct - d.pct : 0
  console.log(
    `  ${String(i + 1).padStart(2)}. ${r.name.padEnd(14)} ${r.contract.padEnd(9)} ` +
      `${(r.pct >= 0 ? '+' : '') + r.pct.toFixed(2)}%   (日报 ${(d.pct >= 0 ? '+' : '') + d.pct.toFixed(2)}%，差 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`,
  )
})
console.log(`\n=== 实时跌幅榜前 20 ===`)
rows.slice(-20).reverse().forEach((r, i) => {
  const d = base.all.find((x) => x.variety === r.variety)
  const delta = d ? r.pct - d.pct : 0
  console.log(
    `  ${String(i + 1).padStart(2)}. ${r.name.padEnd(14)} ${r.contract.padEnd(9)} ` +
      `${r.pct.toFixed(2)}%   (日报 ${d.pct.toFixed(2)}%，差 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`,
  )
})
