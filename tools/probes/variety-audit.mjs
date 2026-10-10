/**
 * 品种完整性审计：直接读原始日报，列出各交易所实际出现的全部品种前缀，
 * 与我们的排名品种集合对比，找出"交易所列了但我们没排"和"官方有但我们完全没有"的品种。
 *
 * 用法：node tools/probes/variety-audit.mjs [YYYYMMDD]
 */
import { httpText } from '../../rank20-daemon/dist/net.js'

const DATE = process.argv[2] ?? '20260917'
const Y = DATE.slice(0, 4)

/** 交易所官方"全部挂牌品种"清单（人工维护，用于发现整品种缺失） */
const OFFICIAL = {
  SHFE: 'cu al zn pb ni sn au ag rb wr hc ss fu bu ru sp ao br ad',
  INE: 'sc nr lu bc ec',
  CZCE: 'CF CY SR TA MA FG SA UR RM OI ZC PM WH RI LR JR SF SM AP CJ PK PF PR SH PX RS',
  DCE: 'a b c cs m y p v l pp j jm i jd eg rr lh eb pg fb bb lg',
  GFEX: 'si lc ps pt pd',
  CFFEX: 'IF IH IC IM T TF TS TL',
}

function prefixes(codes) {
  const set = new Set()
  for (const c of codes) {
    const m = /^([A-Za-z]{1,2})\d{3,4}F?$/.exec(c)
    if (m) set.add(m[1].toUpperCase())
  }
  return set
}

const found = {}

// CZCE
try {
  const t = await httpText(
    `https://www.czce.com.cn/cn/DFSStaticFiles/Future/${Y}/${DATE}/FutureDataDaily.txt`,
    { Referer: 'https://www.czce.com.cn/' },
  )
  const codes = t
    .split('\n')
    .map((l) => l.split('|')[0]?.trim())
    .filter((c) => c && /^[A-Za-z]{1,2}\d{3,4}$/.test(c))
  found.CZCE = { codes, prefixes: prefixes(codes), raw: codes.length }
} catch (e) {
  console.log(`CZCE 读取失败: ${e.message}`)
}

// SHFE
try {
  const t = await httpText(
    `https://www.shfe.com.cn/data/tradedata/future/dailydata/kx${DATE}.dat`,
    { Referer: 'https://www.shfe.com.cn/' },
  )
  const j = JSON.parse(t)
  const codes = (j.o_curInstrument ?? [])
    .map((r) => String(r.INSTRUMENTID ?? '').trim())
    .filter((c) => /^[A-Za-z]{1,2}\d{3,4}$/.test(c))
  found.SHFE = { codes, prefixes: prefixes(codes), raw: codes.length }
} catch (e) {
  console.log(`SHFE 读取失败: ${e.message}`)
}

console.log(`\n===== ${DATE} 各交易所实际出现的品种前缀 =====`)
for (const [ex, v] of Object.entries(found)) {
  const have = [...v.prefixes].sort()
  const want = OFFICIAL[ex].toUpperCase().split(/\s+/)
  const missing = want.filter((w) => !have.includes(w))
  const extra = have.filter((h) => !want.includes(h))
  console.log(`\n${ex}  （合约 ${v.raw} 个，品种 ${have.length} 个）`)
  console.log(`  实际: ${have.join(' ')}`)
  if (missing.length) console.log(`  ⚠️ 官方清单里有但当日无合约: ${missing.join(' ')}`)
  if (extra.length) console.log(`  ⚠️ 实际有但不在官方清单: ${extra.join(' ')}`)
}

// 我们排名里出现的品种
console.log(`\n===== 排名中的品种数（见 diag.mjs 输出）=====`)
console.log('本脚本只回答"官方是否发布了该品种的合约"；排名层面见 diag.mjs 的「被排除」清单。')
