/**
 * 实时行情源探测：可用性 + 字段结构 + 是否含时间戳（用于测更新频率）
 * 用法：node tools/probes/probe-rt.mjs
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const SOURCES = [
  {
    name: '新浪 hq.sinajs.cn',
    url: 'https://hq.sinajs.cn/list=nf_SC2611,nf_MA610,nf_IF2609',
    headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': UA },
  },
  {
    name: '腾讯 qt.gtimg.cn',
    url: 'https://qt.gtimg.cn/q=nf_SC2611,nf_MA610',
    headers: { Referer: 'https://gu.qq.com/', 'User-Agent': UA },
  },
  {
    name: '东财 push2 stock/get',
    url: 'https://push2.eastmoney.com/api/qt/stock/get?secid=113.sc2611&fields=f57,f58,f43,f44,f45,f46,f47,f48,f60,f86,f169,f170',
    headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
  },
  {
    name: '东财 push2 clist(期货列表)',
    url: 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:113&fields=f12,f13,f14,f2,f3,f124',
    headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
  },
  {
    name: '上期所 延时行情 delaymarket.dat',
    url: 'https://www.shfe.com.cn/data/tradedata/future/delaymarket/delaymarket.dat',
    headers: { Referer: 'https://www.shfe.com.cn/', 'User-Agent': UA },
  },
  {
    name: '上期所 实时行情 marketdata.dat',
    url: 'https://www.shfe.com.cn/data/tradedata/future/marketdata/marketdata.dat',
    headers: { Referer: 'https://www.shfe.com.cn/', 'User-Agent': UA },
  },
  {
    name: '能源中心 延时行情',
    url: 'https://www.ine.cn/data/tradedata/future/delaymarket/delaymarket.dat',
    headers: { Referer: 'https://www.ine.cn/', 'User-Agent': UA },
  },
  {
    name: '大商所 实时行情页面接口',
    url: 'http://www.dce.com.cn/publicweb/quotesdata/exportDayQuotesChData.html',
    headers: { Referer: 'http://www.dce.com.cn/', 'User-Agent': UA },
  },
  {
    name: '广期所 实时行情',
    url: 'http://www.gfex.com.cn/u/interfacesWebTiDayQuotes/loadList',
    method: 'POST',
    body: 'variety=si&trade_date=',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: 'http://www.gfex.com.cn',
      Referer: 'http://www.gfex.com.cn/gfex/rihq/hqsj_tjsj.shtml',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
    },
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const s of SOURCES) {
  const t0 = Date.now()
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 15000)
    const res = await fetch(s.url, {
      method: s.method ?? 'GET',
      headers: s.headers,
      body: s.body,
      signal: ctl.signal,
    })
    clearTimeout(timer)
    const text = await res.text()
    const ms = Date.now() - t0
    console.log(`\n===== ${s.name} =====`)
    console.log(`  HTTP ${res.status}  ${ms}ms  ${text.length} 字节`)
    console.log(`  Content-Type: ${res.headers.get('content-type')}`)
    console.log(`  片段: ${text.slice(0, 400).replace(/\s+/g, ' ')}`)
  } catch (e) {
    console.log(`\n===== ${s.name} =====`)
    console.log(`  ✗ ${e.name}: ${e.message}  (${Date.now() - t0}ms)`)
  }
  await sleep(400)
}
