/**
 * 诊断 2：基准日到底该按什么前移？
 * 对每个"基准日被前移"的合约，打印基准日前后 8 个交易日的 结算价 / 成交量 / 收盘价，
 * 用来判断：是"该日无结算价"还是"该日成交量小"。
 *
 * 用法：node tools/probes/diag2.mjs [lookbackDays]
 */
import { fetchAllExchanges } from '../../rank20-daemon/dist/exchanges.js'

const days = Number(process.argv[2] ?? 32)
const map = await fetchAllExchanges(days, () => {})
const dates = Object.keys(map).sort()

/** 从后往前的序号：0 = 最新交易日 */
const pick = (back) => dates[dates.length - 1 - back]

const show = (contract, label) => {
  const c = contract.toLowerCase()
  const rows = []
  for (let b = 26; b >= 12; b--) {
    const d = pick(b)
    const bar = map[d]?.[c]
    rows.push({
      d,
      back: b,
      settle: bar ? bar.settle : undefined,
      vol: bar ? bar.vol : undefined,
      close: bar ? bar.close : undefined,
    })
  }
  console.log(`\n===== ${label}  (${contract}) =====`)
  console.log('  日期        T-N   结算价        成交量      收盘价')
  for (const r of rows) {
    const mark = r.back === 20 ? ' ⟵ T-20(基准日)' : ''
    const s = r.settle === undefined ? '—(无该合约)' : String(r.settle)
    const v = r.vol === undefined ? '—' : String(r.vol)
    const cl = r.close === undefined ? '—' : String(r.close)
    console.log(
      `  ${r.d}  -${String(r.back).padStart(2)}   ${s.padEnd(12)} ${v.padEnd(11)} ${cl}${mark}`,
    )
  }
}

console.log(`交易日=${pick(0)}  基准日(T-20)=${pick(20)}  基准前一日(T-21)=${pick(21)}`)

// 9-17 榜里被前移的合约
show('WR2701', '线材（9-17 被前移到 -21 又兜底到 -26 附近）')
show('PT2612', '铂（9-17 前移一天）')
show('RR2610', '粳米（9-17 前移一天）')
show('BB2611', '胶合板（9-17 前移一天）')
show('RS611', '菜籽（9-17 前移一天；9-16 榜的关键案例）')
show('V2610F', '聚氯乙烯月均价')
show('FB2611', '纤维板（当日量极低）')

// 9-16 榜的关键案例：把锚点固定在 08-19
console.log('\n\n########## 以 2026-08-19 为锚点（9-16 榜的基准日）##########')
const alt = (back) => dates[dates.length - 1 - back]
for (const c of ['rs611', 'bb2611']) {
  console.log(`\n===== ${c} =====`)
  for (let b = 22; b >= 18; b--) {
    const d = alt(b)
    const bar = map[d]?.[c]
    console.log(
      `  ${d}  -${String(b).padStart(2)}  结算=${bar?.settle ?? '—'}  量=${bar?.vol ?? '—'}  收=${bar?.close ?? '—'}`,
    )
  }
}
