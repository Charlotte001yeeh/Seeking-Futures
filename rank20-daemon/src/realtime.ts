/**
 * 盘中实时行情模块 —— 新浪 `hq.sinajs.cn`
 *
 * 实测结论（2026-09-18，见 README「盘中实时更新」）：
 *   · 六所全覆盖；返回 GB18030，必须带 `Referer: https://finance.sina.com.cn`
 *   · **支持批量**：一次请求可取回全部 80+ 个合约 → 整个榜单只花 1 个 HTTP 请求
 *   · 刷新节拍：250ms 轮询中位间隔 515ms；50ms 轮询中位间隔 469ms
 *     → 轮询再快也拿不到新值，**源本身约 500ms（2 次/秒）一拍**，源时间戳粒度为 1 秒
 *   · 金融期货（中金所）明显更慢：中位 0.8–1.5s，最大空档 25s
 *
 * 商品与金融的字段位不同，解析时按字段数区分。
 */
import { CZCE_VARIETIES, UA } from './types.js'
import { CancelledError } from './net.js'

const SINA_REFERER = 'https://finance.sina.com.cn'

/**
 * 官方合约代码 → 新浪代码。
 *
 * 郑商所官方是 3 位月份（`MA610` = 2026 年 10 月），新浪要 4 位（`MA2610`）；
 * 其余五所直接用官方代码。月均价合约（`F` 后缀）新浪不提供，返回空串。
 */
export function sinaSymbol(contract: string): string {
  const m = /^([a-z]{1,2})(\d{3,4})(f?)$/i.exec(contract)
  if (!m) return ''
  const pg = m[1]!.toLowerCase()
  const digits = m[2]!
  const isF = (m[3] ?? '').length > 0
  if (isF) return '' // 新浪无月均价合约行情
  const upper = pg.toUpperCase()
  if (digits.length === 3 && CZCE_VARIETIES.has(pg)) {
    // X=年份个位, YZ=月份 → 补成 4 位年份后两位
    const yearDigit = Number(digits[0])
    const month = digits.slice(1)
    const thisYear = new Date().getFullYear()
    let year = Math.floor(thisYear / 10) * 10 + yearDigit
    if (year < thisYear - 2) year += 10
    return `nf_${upper}${String(year).slice(2)}${month}`
  }
  return `nf_${upper}${digits}`
}

/** 一条行情：最新价 + 源时间戳 + 交易日 */
export interface LiveQuote {
  /** 最新价 */
  price: number
  /** 源时间戳 HHMMSS */
  time: string
  /** 源标注的交易日 YYYY-MM-DD */
  tradeDay: string
  /** 昨结算 */
  prevSettle: number
}

/** 从新浪一行字段里取「最新价」：金融 50 段与商品 44 段的字段位不同 */
function parseQuote(f: string[]): LiveQuote | null {
  const isFin = f.length >= 50
  const price = Number(isFin ? f[3] : f[6])
  if (!Number.isFinite(price) || price <= 0) return null
  return {
    price,
    time: isFin ? '' : String(f[1] ?? ''),
    tradeDay: isFin ? '' : String(f[17] ?? ''),
    prevSettle: Number(isFin ? f[10] ?? 0 : f[10] ?? 0) || 0,
  }
}

/**
 * 批量取最新价。
 * @param contracts 官方合约代码
 * @param opts.timeoutMs 单次请求超时；opts.signal 外部取消信号（实例卸载时 abort）
 * @returns 合约（官方代码，大写）→ 行情；取不到的合约不出现在结果里
 */
export async function fetchLiveQuotes(
  contracts: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Map<string, LiveQuote>> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const outer = opts.signal
  const out = new Map<string, LiveQuote>()
  const pairs: Array<{ code: string; sym: string }> = []
  for (const c of contracts) {
    const sym = sinaSymbol(c)
    if (sym) pairs.push({ code: c.toUpperCase(), sym })
  }
  if (pairs.length === 0) return out

  // 分片，避免 URL 过长（每片 60 个）
  const CHUNK = 60
  for (let i = 0; i < pairs.length; i += CHUNK) {
    if (outer?.aborted) throw new CancelledError('fetchLiveQuotes aborted')
    const slice = pairs.slice(i, i + CHUNK)
    const url = `https://hq.sinajs.cn/list=${slice.map((p) => p.sym).join(',')}`
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const signal = outer ? AbortSignal.any([outer, ctl.signal]) : ctl.signal
    try {
      const res = await fetch(url, {
        headers: { Referer: SINA_REFERER, 'User-Agent': UA },
        signal,
      })
      if (!res.ok) continue
      const text = new TextDecoder('gb18030').decode(Buffer.from(await res.arrayBuffer()))
      const bySym = new Map<string, LiveQuote>()
      for (const line of text.split('\n')) {
        const m = /var hq_str_([A-Za-z0-9_]+)="([^"]*)"/.exec(line)
        if (!m || !m[2]) continue
        const q = parseQuote(m[2].split(','))
        if (q) bySym.set(m[1]!, q)
      }
      for (const p of slice) {
        const q = bySym.get(p.sym)
        if (q) out.set(p.code, q)
      }
    } catch (e) {
      // 卸载取消 → 冒泡（调用方静默退出）；单次网络失败 → 跳过，下一轮再取
      if (outer?.aborted) throw new CancelledError('fetchLiveQuotes aborted')
      if (e instanceof Error && e.name === 'CancelledError') throw e
    } finally {
      clearTimeout(timer)
    }
  }
  return out
}

/**
 * 是否在可交易的时段（本地时区）。
 *
 * 商品日盘 09:00–11:30 / 13:30–15:00；夜盘 21:00–次日 02:30（各品种收盘时间不同，
 * 这里给一个宽区间，取不到行情的合约自然会被跳过）。
 * 中金所股指 09:30–11:30 / 13:00–15:00、国债 09:30–11:30 / 13:00–15:15。
 * 取并集做宽松判断，周末直接排除。
 */
export function inTradingWindow(now: Date = new Date()): boolean {
  const dow = now.getDay()
  if (dow === 0) return false // 周日
  if (dow === 6) {
    // 周六凌晨可能仍在周五夜盘（到 02:30）
    const m = now.getHours() * 60 + now.getMinutes()
    return m <= 150
  }
  const m = now.getHours() * 60 + now.getMinutes()
  if (m >= 9 * 60 && m <= 11 * 60 + 30) return true // 日盘上午
  if (m >= 13 * 60 && m <= 15 * 60 + 15) return true // 日盘下午
  if (m >= 21 * 60) return true // 夜盘
  if (m <= 2 * 60 + 30) return true // 夜盘跨零点
  return false
}
