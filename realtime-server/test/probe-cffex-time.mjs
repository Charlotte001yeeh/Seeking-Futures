/**
 * 只读探测：金融段（中金所）到底有没有"行情时间"字段？
 *
 * 背景：/api/rank20/latest 里 8 个中金所品种 is_live=true 但 quote_time 为空，
 * 现有解析器注释写的是"金融段无此字段"。本脚本把原始字段逐位打出来核实，
 * 并顺便用**生产解析器**（sinaSource.fetch → parseQuote）验证修复后的映射。
 *
 * 用法：node test/probe-cffex-time.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SYMS = ['nf_IF2612', 'nf_T2612', 'nf_TS2612', 'nf_RB2701', 'nf_M2701']

const r = await fetch(`https://hq.sinajs.cn/list=${SYMS.join(',')}`, {
  headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': UA },
})
const text = new TextDecoder('gb18030').decode(Buffer.from(await r.arrayBuffer()))
console.log(`HTTP ${r.status}  本地时间 ${new Date().toLocaleTimeString('zh-CN')}`)

for (const line of text.split('\n')) {
  const m = /var hq_str_([A-Za-z0-9_]+)="([^"]*)"/.exec(line)
  if (!m) continue
  const f = m[2].split(',')
  console.log(`\n──── ${m[1]}   段数=${f.length} ────`)
  f.forEach((v, i) => {
    if (v !== '' && v !== '0') console.log(`  [${String(i).padStart(2)}] ${v}`)
  })
  // 找形如 HHMMSS / HH:MM:SS / YYYY-MM-DD 的字段
  const timeLike = f.map((v, i) => [i, v]).filter(([, v]) => /^\d{6}$/.test(v) || /^\d{1,2}:\d{2}(:\d{2})?$/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v))
  console.log('  疑似时间字段:', timeLike.length ? timeLike.map(([i, v]) => `[${i}]=${v}`).join('  ') : '（无）')
}

// ── 用生产解析器验证映射（这才是真正要保证的）────────────────────────────
console.log('\n════ 生产解析器结果（sinaSource.fetch → parseQuote）════')
const { sinaSource } = await import('../src/sources/sina.mjs')
const { fmtQuoteTime } = await import('../src/ranker.mjs')
const CONTRACTS = ['IF2612', 'IM2612', 'IH2612', 'IC2612', 'T2612', 'TF2612', 'TS2612', 'TL2612', 'RB2701', 'M2701']
const quotes = await sinaSource.fetch(CONTRACTS, { timeoutMs: 8000 })
let bad = 0
for (const c of CONTRACTS) {
  const q = quotes.get(c)
  if (!q) {
    console.log(`  ${c.padEnd(7)} —— 无返回`)
    bad++
    continue
  }
  const ok = /^\d{6}$/.test(q.time) && /^\d{8}$/.test(q.tradeDay.replace(/[^\d]/g, ''))
  if (!ok) bad++
  console.log(`  ${ok ? '✓' : '✗'} ${c.padEnd(7)} quote_time=${fmtQuoteTime(q.time) || '(空)'}  tradeDay=${q.tradeDay}  最新=${q.price}`)
}
console.log(bad === 0 ? `\n✓ 全部 ${CONTRACTS.length} 个合约（含 8 个金融）都解析出 行情时间 + 交易日` : `\n✗ ${bad} 个合约缺时间/交易日`)
process.exit(bad === 0 ? 0 : 1)

