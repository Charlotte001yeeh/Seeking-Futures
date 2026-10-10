/**
 * 数据源连通性探测（**真探测**，不是假状态灯）
 *
 * 对每个源实际发起一次请求并解析：
 *   · 新浪实时行情 —— 取 2 个合约的最新价
 *   · 六所官方日报 —— 复用 rank20-daemon/dist 里**同一套抓取器与解析器**
 *     （因此"连通"= 真的能取到并解析出行数，不是只 ping 通 URL）
 *
 * 结果缓存 60s；同一时刻只允许一个探测在跑（并发合并到同一个 Promise）。
 */
import { log } from './log.mjs'
import { config } from './config.mjs'
import { sinaSource } from './sources/sina.mjs'
import { EXCHANGE_ENDPOINTS, EXCHANGE_FETCHERS, expandEndpoint } from '../../rank20-daemon/dist/exchanges.js'

const CACHE_MS = 60_000

/**
 * 没有基准表时的兜底交易日：从今天往回找最近一个工作日。
 * （纯兜底；正常情况下 server 会传 baseWatcher.table.tradeDate）
 */
export function defaultTradeDate(now = new Date()) {
  const d = new Date(now)
  for (let i = 0; i < 7; i++) {
    const w = d.getDay()
    if (w !== 0 && w !== 6) break
    d.setDate(d.getDate() - 1)
  }
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

let cache = null
let inflight = null

/** 采集模块是否可用（缺失时状态面板如实报告，而不是假装正常） */
let fetchersReady = true
try {
  if (!Array.isArray(EXCHANGE_FETCHERS) || EXCHANGE_FETCHERS.length === 0) fetchersReady = false
} catch {
  fetchersReady = false
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} 超时（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 新浪实时行情源 */
async function probeSina(signal) {
  const t0 = Date.now()
  const probeContracts = ['SC2611', 'RB2701', 'M2701']
  // 展示**真实请求地址**（把探测用的合约代码代进去），而不是占位模板
  const syms = probeContracts.map((c) => sinaSource.symbolOf(c)).filter(Boolean)
  const url = `https://hq.sinajs.cn/list=${syms.join(',')}`
  try {
    const quotes = await withTimeout(
      sinaSource.fetch(probeContracts, { timeoutMs: 8000, signal }),
      9000,
      '新浪实时',
    )
    const ms = Date.now() - t0
    return {
      id: 'sina',
      name: '新浪实时行情',
      kind: 'live',
      url,
      ok: quotes.size > 0,
      latencyMs: ms,
      detail: quotes.size > 0 ? `取到 ${quotes.size}/${probeContracts.length} 个合约` : '无返回数据',
      samples: [...quotes.entries()].slice(0, 2).map(([c, q]) => `${c} ${q.price}`),
    }
  } catch (e) {
    return {
      id: 'sina',
      name: '新浪实时行情',
      kind: 'live',
      url,
      ok: false,
      latencyMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/** 六所官方日报 */
async function probeExchanges(tradeDate, signal) {
  const out = []
  if (!fetchersReady) {
    return [
      {
        id: 'exchange',
        name: '六所官方日报',
        kind: 'eod',
        ok: false,
        error: '未找到采集模块 rank20-daemon/dist/exchanges.js',
      },
    ]
  }
  for (const { name, fn } of EXCHANGE_FETCHERS) {
    const tpl = EXCHANGE_ENDPOINTS[name] ?? ''
    const url = tpl ? expandEndpoint(tpl, tradeDate) : ''
    const t0 = Date.now()
    try {
      // 每次用空 map，只关心"能否取到并解析出行数"
      const rows = await withTimeout(fn({}, tradeDate, signal), 25000, name)
      const ms = Date.now() - t0
      out.push({
        id: name.toLowerCase(),
        name,
        kind: 'eod',
        url,
        ok: rows > 0,
        latencyMs: ms,
        rows,
        detail: rows > 0 ? `${tradeDate} 解析出 ${rows} 个合约` : `${tradeDate} 返回 0 行（可能非交易日）`,
      })
    } catch (e) {
      out.push({
        id: name.toLowerCase(),
        name,
        kind: 'eod',
        url,
        ok: false,
        latencyMs: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return out
}

/**
 * 探测全部数据源。
 * @param {{ force?: boolean, tradeDate?: string, signal?: AbortSignal }} opts
 */
export async function probeSources(opts = {}) {
  const now = Date.now()
  if (!opts.force && cache && now - cache.at < CACHE_MS) return { ...cache, cached: true }
  if (inflight) return inflight

  inflight = (async () => {
    const tradeDate = opts.tradeDate || defaultTradeDate()
    log.info(`开始数据源连通性探测（基准交易日 ${tradeDate}）`)
    const t0 = Date.now()
    const [sina, exchanges] = await Promise.all([
      probeSina(opts.signal),
      probeExchanges(tradeDate, opts.signal),
    ])
    const sources = [sina, ...exchanges]
    const result = {
      at: Date.now(),
      elapsedMs: Date.now() - t0,
      tradeDate,
      cached: false,
      okCount: sources.filter((s) => s.ok).length,
      total: sources.length,
      sources,
    }
    cache = result
    log.info(
      `探测完成：${result.okCount}/${result.total} 可用，用时 ${result.elapsedMs}ms；` +
        sources.map((s) => `${s.name}${s.ok ? '✓' : '✗'}${s.latencyMs}ms`).join(' '),
    )
    return result
  })()

  try {
    return await inflight
  } finally {
    inflight = null
  }
}
