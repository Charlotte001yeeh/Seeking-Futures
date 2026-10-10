/**
 * QuoteSource: 新浪 hq.sinajs.cn（主源，唯一已实测打通的实时源）
 *
 * 实测事实（docs/10 §1.3）：
 *   · 支持批量，85 个合约单轮 ≈150ms
 *   · GB18030 编码，必须带 Referer
 *   · 源自身约 500ms 一拍 → minIntervalMs = 500
 *   · 商品 44 段 / 金融 50 段，字段位不同
 *   · 月均价（F）合约无行情 → unsupported()
 */
import { sinaSymbol, isMonthlyAvg } from './symbols.mjs'

const REFERER = 'https://finance.sina.com.cn'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 字段位假设是否可信的合理性检查：昨结应在最新价的 [0.5, 1.5] 倍内 */
function plausible(ref, price) {
  return Number.isFinite(ref) && ref > 0 && price > 0 && ref > price * 0.5 && ref < price * 1.5
}

/** 解析一行字段 → 报价；解析不出返回 null（宁缺勿猜） */
export function parseQuote(f) {
  if (!Array.isArray(f)) return null
  const isFin = f.length >= 50
  const n = (i) => {
    const v = Number(f[i])
    return Number.isFinite(v) ? v : 0
  }
  const price = isFin ? n(3) : n(6)
  if (!(price > 0)) return null

  const prevSettleRaw = isFin ? n(9) : n(10)
  const prevSettle = plausible(prevSettleRaw, price) ? prevSettleRaw : 0

  return {
    price,
    prevSettle,
    // 当日开/高/低 —— 驱动日K"正在形成的那一根"（日K图实时更新用）
    open: isFin ? n(0) : n(2),
    high: isFin ? n(1) : n(3),
    low: isFin ? n(2) : n(4),
    volume: isFin ? n(4) : n(14),
    oi: isFin ? n(6) : n(13),
    turnover: isFin ? n(5) : 0,
    /**
     * 源时间戳，统一成 6 位 HHMMSS（下游 fmtQuoteTime 只认这一种）。
     * 实测（test/probe-cffex-time.mjs）：
     *   · 商品 44 段：`[1]` = HHMMSS（如 `150431`）
     *   · 金融 50 段：`[37]` = **带冒号的 HH:MM:SS**（如 `15:15:00`，国债期货 15:15 收盘）
     * 早期版本把金融段时间当成"源没有"而置空，导致 8 个中金所品种 is_live=true 却无 quote_time。
     */
    time: isFin ? String(f[37] ?? '').replace(/:/g, '') : String(f[1] ?? ''),
    /** 源标注的交易日：商品 `[17]`、金融 `[36]`（都是 YYYY-MM-DD，下游再归一化） */
    tradeDay: isFin ? String(f[36] ?? '') : String(f[17] ?? ''),
  }
}

export const sinaSource = {
  id: 'sina',
  label: '新浪实时行情',
  /** 源自身刷新节拍的下限（实测中位 515ms @250ms 轮询） */
  minIntervalMs: 500,
  /** 单请求可带的合约数上限（85 个合约一个请求足够） */
  maxSymbolsPerRequest: 120,

  symbolOf: (contract) => sinaSymbol(contract),
  unsupported: (contract) => isMonthlyAvg(contract),

  /**
   * @param {string[]} contracts 官方合约代码
   * @returns {Promise<Map<string, object>>} 官方代码(大写) → 报价
   */
  async fetch(contracts, { timeoutMs = 5000 } = {}) {
    const pairs = []
    for (const c of contracts) {
      if (isMonthlyAvg(c)) continue
      const sym = sinaSymbol(c)
      if (sym) pairs.push({ code: c.toUpperCase(), sym })
    }
    const out = new Map()
    if (pairs.length === 0) return out

    const CHUNK = this.maxSymbolsPerRequest
    for (let i = 0; i < pairs.length; i += CHUNK) {
      const slice = pairs.slice(i, i + CHUNK)
      const url = `https://hq.sinajs.cn/list=${slice.map((p) => p.sym).join(',')}`
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeoutMs)
      try {
        const res = await fetch(url, {
          headers: { Referer: REFERER, 'User-Agent': UA },
          signal: ctl.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = new TextDecoder('gb18030').decode(Buffer.from(await res.arrayBuffer()))
        const bySym = new Map()
        for (const line of text.split('\n')) {
          const m = /var hq_str_([A-Za-z0-9_]+)="([^"]*)"/.exec(line)
          if (!m || !m[2]) continue
          const q = parseQuote(m[2].split(','))
          if (q) bySym.set(m[1], q)
        }
        for (const p of slice) {
          const q = bySym.get(p.sym)
          if (q) out.set(p.code, q)
        }
      } finally {
        clearTimeout(timer)
      }
    }
    return out
  },
}
