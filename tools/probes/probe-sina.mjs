/**
 * 确定新浪实时行情（hq.sinajs.cn）各交易所的合约代码写法。
 * 用法：node tools/probes/probe-sina.mjs
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const CANDIDATES = [
  // SHFE
  'nf_RB2701', 'nf_rb2701', 'RB2701', 'nf_CU2610', 'nf_AU2610',
  // INE
  'nf_SC2611', 'nf_NR2611', 'nf_EC2610',
  // CZCE（3位月份 vs 4位月份）
  'nf_MA610', 'nf_MA2610', 'nf_TA701', 'nf_TA2701', 'nf_CF701', 'nf_SR701',
  // DCE
  'nf_M2701', 'nf_PP2701', 'nf_L2701', 'nf_I2701', 'nf_EG2610',
  // GFEX
  'nf_SI2611', 'nf_LC2701', 'nf_PS2611', 'nf_PT2612',
  // CFFEX
  'nf_IF2609', 'nf_IC2609', 'nf_T2612',
]

async function fetchBatch(list) {
  const url = `https://hq.sinajs.cn/list=${list.join(',')}`
  const res = await fetch(url, {
    headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': UA },
  })
  const buf = Buffer.from(await res.arrayBuffer())
  // sina 返回 GB18030
  const text = new TextDecoder('gb18030').decode(buf)
  const out = {}
  for (const line of text.split('\n')) {
    const m = /var hq_str_([A-Za-z0-9_]+)="([^"]*)"/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// 分两批，避免 URL 过长
const r1 = await fetchBatch(CANDIDATES.slice(0, 15))
const r2 = await fetchBatch(CANDIDATES.slice(15))
const all = { ...r1, ...r2 }

console.log('代码                字段数  内容片段')
console.log('-'.repeat(110))
for (const c of CANDIDATES) {
  const v = all[c]
  const n = v ? v.split(',').length : 0
  console.log(
    `${c.padEnd(20)}${String(n).padStart(4)}   ${v ? v.slice(0, 88) : '✗ 无数据'}`,
  )
}

// 详细拆解一个可用的 SHFE 合约，确认字段含义
const probe = all['nf_SC2611'] || Object.values(all).find((v) => v && v.includes(','))
if (probe) {
  console.log('\n===== 字段拆解（nf_SC2611）=====')
  probe.split(',').forEach((f, i) => console.log(`  [${String(i).padStart(2)}] ${f}`))
}
