/**
 * 新旧基准日规则对比
 *
 * 新规则（用户 2026-09-18 定标）：基准日 = T−20；该日有结算价就用，完全没有才回退。
 * 旧规则：T−20 成交 < 1000 手 → 前移一天。
 *
 * 本脚本用同一份抓取数据，分别以 09-16、09-17 为 T 计算两版榜单，
 * 打印 (a) 新规则下的 9-16 榜与用户已确认值的差异  (b) 新规则下的 9-17 榜。
 *
 * 用法：node tools/probes/compare.mjs [lookbackDays]
 */
import { fetchAllExchanges } from '../../rank20-daemon/dist/exchanges.js'
import { computeRank20 } from '../../rank20-daemon/dist/rank20.js'

const days = Number(process.argv[2] ?? 32)
const map = await fetchAllExchanges(days, (m) => process.stdout.write(m + '\n'))

/** 用户此前逐条确认过的值（9-16 榜） */
const CONFIRMED = {
  sc: 43.85, bu: 32.62, pg: 26.02, ma: 25.35, eg: 22.5, bz: 21.01,
  pl: 20.44, ec: 19.4, lu: 19.13, eb: 18.35, fu: 18.11,
  pp: 12.39, l: 9.63, m: 7.18,
  rb: 1.69, cu: 0.97,
  lc: -16.97, cj: -9.91, lh: -9.81, rs: -9.5, sn: -5.29, ss: -5.22,
  ni: -4.89, cf: -4.89, cy: -3.98, pk: -3.78, cs: -3.61, si: -3.49,
  op: -2.72, ap: -2.7, ps: -2.15, sm: -1.96, bb: -1.92, ao: -1.68,
  c: -1.55, sh: -1.35, if: -1.67,
}

function boardAsOf(cutoff) {
  const filtered = {}
  for (const [d, v] of Object.entries(map)) if (d <= cutoff) filtered[d] = v
  return computeRank20(filtered)
}

const all = Object.keys(map).sort()
console.log(`\n数据区间：${all[0]} ~ ${all[all.length - 1]}`)

// ─────────── 9-16 榜（新规则）与用户已确认值对比 ───────────
const b16 = boardAsOf('20260916')
console.log(`\n########## 9-16 榜（新规则：基准日 ${b16.baseDate}）vs 用户已确认值 ##########`)
const changed = []
let same = 0
for (const [pg, want] of Object.entries(CONFIRMED)) {
  const row = b16.all.find((r) => r.variety === pg)
  if (!row) { console.log(`  ${pg}: 缺失`); continue }
  const oldPct = want
  if (Math.abs(row.pct - oldPct) < 0.005) { same++; continue }
  changed.push({ pg, name: row.name, contract: row.contract, oldPct, newPct: row.pct,
    oldBase: pg === 'rs' ? '20260818/5982' : pg === 'bb' ? '20260818/148.35' : '—',
    newBase: `${row.baseDate}/${row.baseSettle}`, newBaseVol: row.baseVol })
}
console.log(`  与旧值一致：${same} 项`)
console.log(`  发生变化：${changed.length} 项`)
if (changed.length) {
  console.log('\n  | 品种 | 主力合约 | 文华(已确认) | 新规则算出 | 差 | 基准日/基准结算 | T-20成交量 |')
  console.log('  | --- | --- | ---: | ---: | ---: | --- | ---: |')
  for (const c of changed) {
    console.log(`  | ${c.name} | ${c.contract} | ${c.oldPct.toFixed(2)}% | ${c.newPct.toFixed(2)}% | ${(c.newPct - c.oldPct).toFixed(2)} | ${c.newBase} | ${c.newBaseVol} |`)
  }
}
console.log(`\n  9-16 基准日例外：${b16.all.filter(r => r.baseDate !== b16.baseDate).map(r => `${r.name}→${r.baseDate}`).join('、') || '无'}`)

// ─────────── 9-17 榜（新规则）───────────
const b17 = boardAsOf('20260917')
console.log(`\n########## 9-17 榜（新规则：基准日 ${b17.baseDate}，${b17.all.length} 个品种）##########`)
console.log(`\n  【涨幅榜】`)
b17.gainers.forEach((r, i) =>
  console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(14)} ${r.contract.padEnd(9)} ${(r.pct >= 0 ? '+' : '') + r.pct.toFixed(2)}%  基=${r.baseSettle}@${r.baseDate}(量${r.baseVol})`),
)
console.log(`\n  【跌幅榜】`)
b17.losers.forEach((r, i) =>
  console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(14)} ${r.contract.padEnd(9)} ${r.pct.toFixed(2)}%  基=${r.baseSettle}@${r.baseDate}(量${r.baseVol})`),
)
const shifted17 = b17.all.filter((r) => r.baseDate !== b17.baseDate)
console.log(`\n  9-17 基准日例外（T−20 无结算价才回退）：${shifted17.map((r) => `${r.name}→${r.baseDate}`).join('、') || '无'}`)

// 重点核对品种
console.log(`\n  【重点核对】`)
for (const k of ['pt', 'rr', 'bb', 'rs', 'wr', 'vF', 'ppF', 'lF']) {
  const r = b17.all.find((x) => x.variety === k)
  if (r) console.log(`    ${r.name.padEnd(14)} ${r.contract.padEnd(9)} ${(r.pct >= 0 ? '+' : '') + r.pct.toFixed(2)}%  基=${r.baseSettle}@${r.baseDate}`)
}
