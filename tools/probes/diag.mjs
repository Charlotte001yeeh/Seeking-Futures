/**
 * 诊断：品种完整性 + 基准日取值 + 主力判定
 * 用法：node tools/probes/diag.mjs [lookbackDays]
 */
import { fetchAllExchanges } from '../../rank20-daemon/dist/exchanges.js'
import { groupKey, resolveBase, BASE_OFFSET } from '../../rank20-daemon/dist/rank20.js'
import { NAME, DCE_VARIETIES, FINANCIAL } from '../../rank20-daemon/dist/types.js'

const days = Number(process.argv[2] ?? 32)
const map = await fetchAllExchanges(days, (m) => process.stdout.write(m + '\n'))
const dates = Object.keys(map).sort()
const tradeDate = dates[dates.length - 1]
const prevDate = dates[dates.length - 2]
const anchorDate = dates[dates.length - 1 - BASE_OFFSET]
const anchorPrev = dates[dates.length - 2 - BASE_OFFSET]

console.log(`\n交易日=${tradeDate}  T-1=${prevDate}  基准日(T-20)=${anchorDate}  基准前一日=${anchorPrev}`)

// 按品种分组
const group = {}
for (const d of dates) {
  for (const [contract, bar] of Object.entries(map[d] ?? {})) {
    const { key } = groupKey(contract)
    ;(group[key] ??= {})[contract] ??= []
    group[key][contract].push(bar)
  }
}

const keys = Object.keys(group).sort()
console.log(`\n发现品种组 ${keys.length} 个`)

const rows = []
const skipped = []
for (const key of keys) {
  const contracts = group[key]
  const isF = key.endsWith('F')
  const pg = isF ? key.slice(0, -1) : key

  // R4 主力 = T-1 量最大
  let main = null
  let bestVol = -1
  for (const [c, seq] of Object.entries(contracts)) {
    const v = seq.find((b) => b.d === prevDate)?.vol ?? 0
    if (v > bestVol) { bestVol = v; main = c }
  }
  let degraded = false
  if (!main || bestVol <= 0) {
    degraded = true
    bestVol = -1
    for (const [c, seq] of Object.entries(contracts)) {
      const v = seq.find((b) => b.d === tradeDate)?.vol ?? 0
      if (v > bestVol) { bestVol = v; main = c }
    }
  }
  if (!main) { skipped.push([key, '无任何合约']); continue }

  const seq = contracts[main]
  const today = seq.find((b) => b.d === tradeDate)
  if (!today || !Number.isFinite(today.close) || today.close === 0 || today.vol <= 0) {
    skipped.push([key, `${main} 当日无有效成交（vol=${today?.vol ?? '-'} close=${today?.close ?? '-'}）`])
    continue
  }

  const base = resolveBase(seq, anchorDate)
  if (!base) { skipped.push([key, `${main} 基准日及之前无有效数据`]); continue }

  const pct = ((today.close - base.bar.settle) / base.bar.settle) * 100
  rows.push({
    key, pg, main, isF, degraded, pct,
    close: today.close, settle: today.settle, vol: today.vol, oi: today.oi,
    baseDate: base.bar.d, baseSettle: base.bar.settle, baseVol: base.bar.vol,
    shifted: base.bar.d !== anchorDate,
    name: (NAME[pg] ?? `❓${pg.toUpperCase()}`) + (isF ? '月均价' : ''),
    unknownName: !NAME[pg],
    seqLen: seq.length,
    firstDate: seq[0]?.d,
    listed: seq[0]?.d > anchorDate ? `⚠️ 基准日后才上市（首日 ${seq[0]?.d}）` : '',
  })
}

rows.sort((a, b) => b.pct - a.pct)

console.log(`\n纳入排名 ${rows.length} 个品种组`)
console.log(`\n=== 全部纳入的品种组（按涨跌幅降序）===`)
for (const r of rows) {
  const flag = [
    r.shifted ? `基准前移→${r.baseDate}` : '',
    r.degraded ? 'T-1无量降级' : '',
    r.listed,
    r.unknownName ? '名称未知' : '',
  ].filter(Boolean).join(' / ')
  console.log(
    `  ${(r.pct >= 0 ? '+' : '') + r.pct.toFixed(2)}%`.padStart(9) +
    `  ${r.name.padEnd(14)} ${r.main.toUpperCase().padEnd(9)}` +
    ` 基=${r.baseSettle}@${r.baseDate}(量${r.baseVol})  今=${r.close}(量${r.vol})  序列${r.seqLen}根` +
    (flag ? `  ⟵ ${flag}` : ''),
  )
}

console.log(`\n=== 被排除的品种组 ${skipped.length} 个 ===`)
for (const [k, why] of skipped) console.log(`  ${k.padEnd(8)} ${NAME[k.replace(/F$/, '')] ?? ''} — ${why}`)

console.log(`\n=== 汇总 ===`)
console.log(`  交易日 ${tradeDate} / 基准日 ${anchorDate}`)
console.log(`  品种组总数 ${keys.length}  纳入 ${rows.length}  排除 ${skipped.length}`)
console.log(`  其中金融 ${rows.filter((r) => FINANCIAL.has(r.pg)).length}  月均价 ${rows.filter((r) => r.isF).length}`)
console.log(`  名称未知（需补 NAME 表）：${rows.filter((r) => r.unknownName).map((r) => r.pg).join(', ') || '无'}`)
console.log(`  基准日示例：主线合约首日 > 基准日的：${rows.filter((r) => r.listed).length} 个`)
