/**
 * 排名计算：基准（官方日报，分母） + 实时最新价（分子） → rank20 双榜。
 *
 * 严格遵循 docs/10 §3.2 的溯源要求：每一行都带齐
 *   source / quote_time / is_live / base_settle / base_date / rolled_over
 * 缺任一 → 该行不进榜（宁可少一行也不给无法溯源的数字）。
 */

/** 把行情时间统一成 HH:MM:SS（接受 HHMMSS 与 HH:MM:SS 两种源格式） */
export function fmtQuoteTime(hhmmss) {
  const s = String(hhmmss ?? '')
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`
  return /^\d{1,2}:\d{2}:\d{2}$/.test(s) ? s : ''
}

/** 源标注的交易日 "2026-09-18" → "20260918" */
export function normTradeDay(v) {
  const s = String(v ?? '').replace(/[^\d]/g, '')
  return /^\d{8}$/.test(s) ? s : ''
}

/**
 * @param {import('./base.mjs').BaseTable} base
 * @param {Map<string,object>} quotes   官方代码(大写) → 报价
 * @param {{sourceId:string, prevRank?:Map<string,number>, now?:Date}} ctx
 */
export function buildSnapshot(base, quotes, ctx) {
  const now = ctx.now ?? new Date()

  // 实时行情带回来的交易日（商品段有；金融段没有 → 取多数）
  const liveTradeDate =
    [...quotes.values()]
      .map((q) => normTradeDay(q.tradeDay))
      .filter(Boolean)
      .sort()
      .pop() ?? ''

  const anchor = base.resolveAnchor(liveTradeDate)

  const rows = []
  let liveCount = 0
  let maxTime = ''
  let missingAnchor = 0

  for (const r of base.rows) {
    const a = anchor.byVariety.get(r.variety)
    if (!a || !(a.settle > 0)) {
      missingAnchor++
      continue
    }
    const q = quotes.get(r.contract.toUpperCase())
    const isLive = !!q
    if (isLive) liveCount++

    const price = isLive ? q.price : r.close
    if (!(price > 0)) continue

    const pct20 = ((price - a.settle) / a.settle) * 100
    const pct1 =
      isLive && q.prevSettle > 0 ? ((price - q.prevSettle) / q.prevSettle) * 100 : null

    if (isLive && q.time && q.time > maxTime) maxTime = q.time

    rows.push({
      variety: r.variety,
      name: r.name,
      contract: r.contract,
      pct_20d: round(pct20, 2),
      pct_1d: pct1 === null ? null : round(pct1, 2),
      price: round(price, 4),
      // 当日开/高/低 —— 供前端 K 线面板滚动"正在形成的那一根"，避免另发请求
      open: isLive && q.open > 0 ? round(q.open, 4) : null,
      high: isLive && q.high > 0 ? round(q.high, 4) : null,
      low: isLive && q.low > 0 ? round(q.low, 4) : null,
      base_settle: a.settle,
      base_date: a.date,
      base_shifted: a.shifted,
      base_fallback: a.fallback,
      volume: isLive ? q.volume : r.vol,
      oi: isLive ? q.oi : r.oi,
      oi_change: isLive && r.oi > 0 && q.oi > 0 ? q.oi - r.oi : null,
      // 成交额：官方日报未解析、实时源仅金融段提供 → 明确置 null，不伪造
      turnover: isLive && q.turnover > 0 ? q.turnover : null,
      is_live: isLive,
      quote_time: isLive ? fmtQuoteTime(q.time) : '',
      source: isLive ? ctx.sourceId : 'daily_snapshot',
      rolled_over: anchor.rolled,
    })
  }

  rows.sort((x, y) => y.pct_20d - x.pct_20d || (x.variety < y.variety ? -1 : 1))

  // 排名变化（相对上一轮快照），供前端 ↑↓ 指示
  const prev = ctx.prevRank
  rows.forEach((row, i) => {
    row.rank = i + 1
    const p = prev?.get(row.variety)
    row.rank_change = p === undefined ? null : p - (i + 1)
  })

  const gainers = rows.slice(0, 20)
  const losers = rows.slice(-20).reverse()

  // 行情新鲜度：用源时间戳（秒级）与本地时钟比
  let ageMs = null
  if (maxTime) {
    const hh = Number(maxTime.slice(0, 2))
    const mm = Number(maxTime.slice(2, 4))
    const ss = Number(maxTime.slice(4, 6))
    const t = new Date(now)
    t.setHours(hh, mm, ss, 0)
    let d = now.getTime() - t.getTime()
    if (d < -60000) d += 24 * 3600 * 1000 // 跨零点
    ageMs = Math.max(0, d)
  }

  return {
    seq: 0, // 由 snapshot 模块赋值
    tradeDate: liveTradeDate || base.tradeDate,
    baseDate: anchor.baseDate,
    rolled: anchor.rolled,
    quoteTime: fmtQuoteTime(maxTime),
    serverTime: now.toISOString(),
    ageMs,
    liveCount,
    total: rows.length,
    missingAnchor,
    gainers,
    losers,
    all: rows,
  }
}

function round(v, digits) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}
