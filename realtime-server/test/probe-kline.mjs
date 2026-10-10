/**
 * 日K线数据源核查（只读探测，不改产品代码）
 *
 * 要回答：现有/可用的数据源能否为「rank20 主力合约」提供
 *   ① 含 OHLC 的历史日K（够画图，≥120 根）
 *   ② 能驱动当日最后一根K线的实时更新
 *
 * 用法：node test/probe-kline.mjs
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// 覆盖六所各一个主力合约（CZCE 用新浪的 4 位月份写法）
const SAMPLES = [
  ['SHFE', 'RB2701'],
  ['INE', 'SC2611'],
  ['CZCE', 'MA2610'],
  ['DCE', 'M2701'],
  ['GFEX', 'LC2701'],
  ['CFFEX', 'IF2609'],
]

async function get(url, headers = {}, asBuffer = false) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 12000)
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal })
    const buf = Buffer.from(await r.arrayBuffer())
    return { status: r.status, text: asBuffer ? buf : buf.toString('utf8'), buf }
  } catch (e) {
    return { status: 0, text: `FETCH_FAIL ${e.name}: ${e.message}`, buf: null }
  } finally {
    clearTimeout(t)
  }
}

console.log('════════ A. 新浪期货日K（jsonp） ════════')
for (const [ex, sym] of SAMPLES) {
  const url = `https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20k=/InnerFuturesNewService.getDailyKLine?symbol=${sym}`
  const r = await get(url, { Referer: 'https://finance.sina.com.cn' })
  let bars = null
  if (r.status === 200) {
    const m = /=\s*\((\[.*\])\)/s.exec(r.text) || /=\s*(\[.*\])/s.exec(r.text)
    if (m) {
      try {
        bars = JSON.parse(m[1])
      } catch {
        /* 解析失败保持 null */
      }
    }
  }
  const n = Array.isArray(bars) ? bars.length : 0
  console.log(
    `  ${ex.padEnd(6)} ${sym.padEnd(8)} HTTP ${r.status}  ${n ? `${n} 根` : '无数据'}  ${n ? JSON.stringify(bars.at(-1)).slice(0, 120) : r.text.slice(0, 90).replace(/\s+/g, ' ')}`,
  )
  await new Promise((s) => setTimeout(s, 300))
}

console.log('\n════════ B. 东方财富日K ════════')
// 东财市场码：113=上期所 114=大商所 115=郑商所 8=中金所 142=广期所
for (const [ex, code, mk] of [
  ['SHFE', 'RB2701', 113],
  ['INE', 'SC2611', 113],
  ['CZCE', 'MA610', 115],
  ['DCE', 'M2701', 114],
  ['GFEX', 'LC2701', 142],
  ['CFFEX', 'IF2609', 8],
]) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${mk}.${code}&klt=101&fqt=0&beg=0&end=20500101&lmt=130&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`
  const r = await get(url, { Referer: 'https://quote.eastmoney.com/' })
  let kl = null
  try {
    kl = JSON.parse(r.text)?.data?.klines
  } catch {
    /* ignore */
  }
  console.log(
    `  ${ex.padEnd(6)} ${code.padEnd(8)} mk=${String(mk).padEnd(4)} HTTP ${r.status}  ${Array.isArray(kl) ? `${kl.length} 根  ${kl.at(-1)}` : r.text.slice(0, 90).replace(/\s+/g, ' ')}`,
  )
  await new Promise((s) => setTimeout(s, 300))
}

console.log('\n════════ C. 交易所官方日报是否含 OHLC（现有抓取器的原始字段） ════════')
// SHFE
{
  const r = await get('https://www.shfe.com.cn/data/tradedata/future/dailydata/kx20260918.dat', {
    Referer: 'https://www.shfe.com.cn/',
  })
  try {
    const j = JSON.parse(r.text)
    const row = (j.o_curinstrument ?? []).find((x) => x.PRODUCTGROUPID === 'rb')
    console.log('  SHFE 字段:', row ? Object.keys(row).filter((k) => /PRICE|VOLUME|INTEREST/i.test(k)).join(', ') : `HTTP ${r.status}`)
    if (row) console.log('         样例:', JSON.stringify({ id: row.INSTRUMENTID, open: row.OPENPRICE, high: row.HIGHESTPRICE, low: row.LOWESTPRICE, close: row.CLOSEPRICE, settle: row.SETTLEMENTPRICE }))
  } catch {
    console.log('  SHFE 解析失败 HTTP', r.status)
  }
}
// CZCE
{
  const r = await get('https://www.czce.com.cn/cn/DFSStaticFiles/Future/2026/20260918/FutureDataDaily.txt', {
    Referer: 'https://www.czce.com.cn/',
  })
  const lines = r.text.split(/\r?\n/).filter((l) => l.includes('|'))
  console.log('  CZCE 表头:', lines[0]?.slice(0, 120))
  const row = lines.find((l) => /^MA\d{3}/.test(l))
  console.log('         样例:', row?.slice(0, 120))
}
// CFFEX
{
  const r = await get('http://www.cffex.com.cn/sj/hqsj/rtj/202609/18/20260918_1.csv', {
    Referer: 'http://www.cffex.com.cn/',
  })
  const lines = r.text.split(/\r?\n/).filter((l) => l.trim())
  console.log('  CFFEX 表头:', lines[0]?.slice(0, 140))
  console.log('         样例:', lines.find((l) => /^IF/.test(l))?.slice(0, 140))
}
