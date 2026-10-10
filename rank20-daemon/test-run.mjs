/**
 * 离线验证：直接调用 exchanges + rank20，不经过 Cordis 宿主。
 * 用法：node test-run.mjs [lookbackDays] [cutoffDate]
 *   node test-run.mjs 32 20260916   # 固定复算 9-16 榜，与用户已确认值比对（默认）
 *
 * 用于在注入前确认抓取与算法正确，并与 docs/09 的已验证榜单比对。
 *
 * ⚠️ 窗口**锚定在 cutoff**（不是今天）：否则 32 个工作日的窗口会随真实日期往前漂，
 *    某天起就再也盖不住 cutoff 之前应有的 21 个交易日，表现为"品种数=0 / 命中 0/34"
 *    的假失败（2026-10-10 实测踩到）。锚定后本回归与运行日期无关。
 * 退出码：命中数 < 总数 → 1（回归测试必须能失败）。
 */
import { fetchAllExchanges } from './dist/exchanges.js'
import { computeRank20, renderMarkdown } from './dist/rank20.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const days = Number(process.argv[2] ?? 32)
// 期望值来自 9-16 榜，所以默认把数据截到 9-16 再算，否则会拿最新交易日去对旧期望值
const CUTOFF = process.argv[3] ?? '20260916'
const cutoffDate = new Date(Number(CUTOFF.slice(0, 4)), Number(CUTOFF.slice(4, 6)) - 1, Number(CUTOFF.slice(6, 8)))
// 复算产物单独放 rank20/regression/：避免和每日任务写出的真实日报混在一起
// （历史上曾写到插件目录下的 rank20/，把仓库搞乱）
const outDir = join(process.cwd(), '..', 'rank20', 'regression')

/**
 * docs/09 已由用户确认的期望值（2026-09-16 榜）。
 *
 * ⚠️ 2026-09-18 基准日规则修正后，菜籽/胶合板两项与用户早期读数不同：
 *    旧规则（成交量阈值）rs=-9.50 bb=-1.92
 *    新规则（结算价判定）  rs=-8.53 bb=-2.02  ← 以这两个为准，需回查文华
 */
const EXPECTED = {
  sc: 43.85, bu: 32.62, pg: 26.02, ma: 25.35, eg: 22.5, bz: 21.01,
  pl: 20.44, ec: 19.4, lu: 19.13, eb: 18.35, fu: 18.11,
  rb: 1.69, cu: 0.97,
  lc: -16.97, cj: -9.91, lh: -9.81, rs: -8.53, sn: -5.29, ss: -5.22,
  ni: -4.89, cf: -4.89, cy: -3.98, pk: -3.78, cs: -3.61, si: -3.49,
  op: -2.72, ap: -2.7, ps: -2.15, sm: -1.96, bb: -2.02, ao: -1.68,
  c: -1.55, sh: -1.35, if: -1.67,
}

const log = (m) => console.log(m)

console.log(`=== 抓取 ${days} 个工作日（窗口锚定 cutoff=${CUTOFF}）===`)
const t0 = Date.now()
const map = await fetchAllExchanges(days, log, undefined, cutoffDate)
console.log(`抓取完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

// 截到 CUTOFF：期望值锚定在 9-16 榜
const scoped = {}
for (const [d, v] of Object.entries(map)) if (d <= CUTOFF) scoped[d] = v

const result = computeRank20(scoped)
console.log(`\n交易日=${result.tradeDate} 基准日=${result.baseDate} 品种数=${result.all.length}（数据截到 ${CUTOFF}）`)
for (const d of result.diagnostics) console.log(`  诊断: ${d}`)

console.log('\n=== 与已确认值比对 ===')
let hit = 0
let total = 0
const misses = []
for (const [pg, want] of Object.entries(EXPECTED)) {
  const row = result.all.find((r) => r.variety === pg)
  total++
  if (!row) {
    misses.push(`${pg}: 缺失`)
    continue
  }
  const dev = Math.abs(row.pct - want)
  if (dev < 0.05) hit++
  else misses.push(`${pg}: 我 ${row.pct.toFixed(2)} vs 期望 ${want} (差 ${dev.toFixed(2)})`)
}
console.log(`命中 ${hit}/${total}`)
if (misses.length) misses.forEach((m) => console.log(`  ✗ ${m}`))

console.log('\n=== 涨幅榜前 20 ===')
result.gainers.forEach((r, i) =>
  console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(12)} ${r.contract.padEnd(9)} ${(r.pct >= 0 ? '+' : '') + r.pct.toFixed(2)}%  (基 ${r.baseSettle} @ ${r.baseDate})`),
)
console.log('\n=== 跌幅榜前 20 ===')
result.losers.forEach((r, i) =>
  console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(12)} ${r.contract.padEnd(9)} ${r.pct.toFixed(2)}%  (基 ${r.baseSettle} @ ${r.baseDate})`),
)

mkdirSync(outDir, { recursive: true })
const p = (n) => String(n).padStart(2, '0')
const now = new Date()
const stamp = `${now.getFullYear()}年${p(now.getMonth() + 1)}月${p(now.getDate())}日${p(now.getHours())}时`
const mdPath = join(outDir, `${stamp}.md`)
writeFileSync(mdPath, renderMarkdown(result), 'utf8')
console.log(`\n已写出 ${mdPath}`)

// 回归必须能失败：命中数不足即以非零码退出（否则"测试永远绿"毫无意义）
if (hit !== total) {
  console.log(`\n=== 结果：命中 ${hit}/${total} —— 未达预期，退出码 1 ===`)
  process.exit(1)
}
console.log(`\n=== 结果：命中 ${hit}/${total} —— 全部命中 ✓ ===`)
process.exit(0)
