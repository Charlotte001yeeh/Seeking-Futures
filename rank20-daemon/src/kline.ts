/**
 * 日 K 线构建（零依赖）
 *
 * 数据分层（**官方优先，绝不伪造**）：
 *   1. 官方日报（六所，已有抓取器）—— 最近 lookbackDays 个交易日的权威 OHLC + 量 + 持仓 + 成交额
 *   2. 新浪期货日K —— 官方窗口之外的历史（真实行情，非估算）
 *   3. 实时行情 —— 盘中驱动"正在形成的那一根"（由 realtime-server 负责，本模块不涉及）
 *
 * 合并规则：**同一天官方数据永远覆盖第三方**；第三方只用于官方没有覆盖的日期。
 * 每根 bar 都带 `src` 标明来源，前端据此显示，可逐根复核。
 */
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { httpText, sleep, isCancelled } from './net.js'
import { FINANCIAL, CZCE_VARIETIES, type DayBar, type SettleMap } from './types.js'

export const KLINE_SCHEMA_VERSION = 1

/** K 线保留的最大根数 */
export const KLINE_MAX_BARS = 250

/** 一根日K */
export interface KBar {
  /** 交易日 YYYYMMDD */
  d: string
  o: number
  h: number
  l: number
  c: number
  /** 结算价（CFFEX 无收盘价，c 与 s 相同） */
  s: number
  v: number
  oi: number
  /** 成交额（万元），官方日报有则填 */
  to?: number
  /** 数据来源：eod=官方日报 | eod_settle_as_close=官方日报(中金所无收盘价) | sina=公开行情接口 */
  src: 'eod' | 'eod_settle_as_close' | 'sina'
  /** 开高低若取自别处（官方缺该字段时的真实回退），在此标明 */
  ohlSrc?: 'sina'
}

export interface KlineFile {
  schemaVersion: number
  contract: string
  variety: string
  name: string
  updatedAt: string
  /** 参与合成的来源清单 */
  sources: string[]
  /** 官方日报覆盖的起始交易日（此日期及之后为官方口径） */
  officialFrom: string
  bars: KBar[]
  rollovers: Array<{ d: string; from: string; to: string }>
}

/** 官方代码 → 新浪日K代码（去掉实时行情的 nf_ 前缀） */
export function sinaKlineSymbol(sinaRealtimeSymbol: string): string {
  return sinaRealtimeSymbol.replace(/^nf_/i, '')
}

/**
 * 官方合约代码 → 新浪**日K**代码。
 *
 * ⚠️ 与实时行情的 `sinaSymbol()` 关键差别：**月均价 F 合约也支持**
 * （实测 `PP2611F` 81 根、`L2611F` 81 根、`V2610F` 118 根）。
 * 实时行情对 F 合约返回空，所以不能复用那个函数。
 */
export function sinaKlineCode(contract: string, now = new Date()): string {
  const m = /^([a-z]{1,2})(\d{3,4})(f?)$/i.exec(String(contract ?? ''))
  if (!m) return ''
  const pg = m[1]!.toLowerCase()
  const digits = m[2]!
  const isF = (m[3] ?? '').length > 0
  const upper = pg.toUpperCase()
  let body: string
  if (digits.length === 3 && CZCE_VARIETIES.has(pg)) {
    // 郑商所官方 3 位月份 → 新浪 4 位
    const yearDigit = Number(digits[0])
    const month = digits.slice(1)
    const thisYear = now.getFullYear()
    let year = Math.floor(thisYear / 10) * 10 + yearDigit
    if (year < thisYear - 2) year += 10
    body = `${upper}${String(year).slice(2)}${month}`
  } else {
    body = `${upper}${digits}`
  }
  return isF ? `${body}F` : body
}

/**
 * 抓取新浪期货日K（真实行情数据）。
 * @returns 升序 K 线；失败抛错（由调用方决定是否降级为"仅官方窗口"）
 */
export async function fetchSinaDailyKline(
  klineSymbol: string,
  opts: { signal?: AbortSignal; retries?: number } = {},
): Promise<KBar[]> {
  const url = `https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20k=/InnerFuturesNewService.getDailyKLine?symbol=${encodeURIComponent(klineSymbol)}`
  const text = await httpText(url, {
    headers: { Referer: 'https://finance.sina.com.cn' },
    retries: opts.retries ?? 2,
    timeoutMs: 15000,
    signal: opts.signal,
  })
  const i = text.indexOf('[')
  const j = text.lastIndexOf(']')
  if (i < 0 || j <= i) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(i, j + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const out: KBar[] = []
  for (const r of raw as Array<Record<string, string>>) {
    const d = String(r.d ?? '').replace(/-/g, '')
    const o = Number(r.o)
    const h = Number(r.h)
    const l = Number(r.l)
    const c = Number(r.c)
    if (!/^\d{8}$/.test(d)) continue
    // 字段不全就丢弃这根（不补造）
    if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue
    out.push({
      d,
      o,
      h,
      l,
      c,
      s: Number(r.s) || 0,
      v: Number(r.v) || 0,
      oi: Number(r.p) || 0,
      src: 'sina',
    })
  }
  out.sort((a, b) => (a.d < b.d ? -1 : 1))
  return out
}

/**
 * 把官方日报窗口与第三方历史合并，**官方优先**。
 * @param official 官方窗口内的日线（来自 SettleMap），key=YYYYMMDD
 * @param sina 第三方历史（升序）
 * @param isFinancial 是否中金所品种（官方无收盘价列）
 */
export function mergeKline(
  official: Map<string, DayBar>,
  sina: KBar[],
  isFinancial: boolean,
): { bars: KBar[]; officialFrom: string } {
  const byDate = new Map<string, KBar>()

  // 1) 先铺第三方历史
  for (const b of sina) byDate.set(b.d, b)

  // 2) 官方窗口逐日覆盖（权威）
  let officialFrom = ''
  for (const [d, bar] of official) {
    if (!(bar.close > 0) || !(bar.settle > 0)) continue
    const o = Number.isFinite(bar.open) && (bar.open as number) > 0 ? (bar.open as number) : undefined
    const h = Number.isFinite(bar.high) && (bar.high as number) > 0 ? (bar.high as number) : undefined
    const l = Number.isFinite(bar.low) && (bar.low as number) > 0 ? (bar.low as number) : undefined
    const prev = byDate.get(d)
    if (!officialFrom || d < officialFrom) officialFrom = d
    byDate.set(d, {
      d,
      // 官方缺开高低时，用第三方**真实**值回退并标注；两者都没有就不写这个字段（由前端跳过画蜡烛）
      o: o ?? prev?.o ?? bar.close,
      h: h ?? prev?.h ?? bar.close,
      l: l ?? prev?.l ?? bar.close,
      c: bar.close,
      s: bar.settle,
      v: bar.vol || 0,
      oi: bar.oi || 0,
      to: Number.isFinite(bar.turnover) && (bar.turnover as number) > 0 ? (bar.turnover as number) : undefined,
      src: isFinancial ? 'eod_settle_as_close' : 'eod',
      ...(o === undefined || h === undefined || l === undefined ? { ohlSrc: 'sina' as const } : {}),
    })
  }

  const bars = [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : 1))
  return { bars: bars.slice(-KLINE_MAX_BARS), officialFrom }
}

/** 取某合约在官方窗口内的日线 */
export function officialBarsFor(map: SettleMap, contract: string): Map<string, DayBar> {
  const code = contract.toLowerCase()
  const out = new Map<string, DayBar>()
  for (const d of Object.keys(map).sort()) {
    const bar = map[d]?.[code]
    if (bar) out.set(d, bar)
  }
  return out
}

export interface KlineSummary {
  contracts: number
  bars: number
  officialOnly: number
  failed: string[]
  index: Record<string, { bars: number; first: string; last: string; officialFrom: string }>
}

/**
 * 为给定品种（各自的主力合约）刷新日 K 线并落盘。
 *
 * 输出：<outDir>/kline/<合约>.json + <outDir>/kline/index.json
 * 失败处理：单个合约抓取失败 → 只写官方窗口那一段并如实标注，**不伪造历史**。
 */
export async function refreshKline(
  outDir: string,
  rows: Array<{ variety: string; name: string; contract: string }>,
  map: SettleMap,
  opts: {
    log?: (m: string) => void
    signal?: AbortSignal
    /** 合约 → 新浪日K代码 */
    symbolOf: (contract: string) => string
    gapMs?: number
  },
): Promise<KlineSummary> {
  const log = opts.log ?? (() => {})
  const dir = join(outDir, 'kline')
  mkdirSync(dir, { recursive: true })
  const summary: KlineSummary = { contracts: 0, bars: 0, officialOnly: 0, failed: [], index: {} }
  const gap = opts.gapMs ?? 30

  for (const row of rows) {
    if (opts.signal?.aborted) break
    const isFin = FINANCIAL.has(row.variety.replace(/F$/, ''))
    const official = officialBarsFor(map, row.contract)
    let sina: KBar[] = []
    try {
      const sym = opts.symbolOf(row.contract)
      if (sym) {
        sina = await fetchSinaDailyKline(sym, { signal: opts.signal })
      }
    } catch (e) {
      if (isCancelled(e)) break
      summary.failed.push(row.contract)
      log(`  ⚠️ ${row.contract} 历史K线抓取失败（将只用官方窗口）：${e instanceof Error ? e.message : String(e)}`)
    }
    if (sina.length === 0 && official.size === 0) continue

    const { bars, officialFrom } = mergeKline(official, sina, isFin)
    if (bars.length === 0) continue
    if (sina.length === 0) summary.officialOnly++

    const doc: KlineFile = {
      schemaVersion: KLINE_SCHEMA_VERSION,
      contract: row.contract,
      variety: row.variety,
      name: row.name,
      updatedAt: new Date().toISOString(),
      sources: [...new Set(bars.map((b) => b.src))],
      officialFrom,
      bars,
      rollovers: [],
    }
    writeFileSync(join(dir, `${row.contract}.json`), JSON.stringify(doc), 'utf8')
    summary.contracts++
    summary.bars += bars.length
    summary.index[row.contract] = {
      bars: bars.length,
      first: bars[0]!.d,
      last: bars[bars.length - 1]!.d,
      officialFrom,
    }
    if (gap > 0) await sleep(gap, opts.signal)
  }

  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify(
      { schemaVersion: KLINE_SCHEMA_VERSION, updatedAt: new Date().toISOString(), ...summary },
      null,
      2,
    ),
    'utf8',
  )

  // 清理已不在榜内的旧合约文件（主力换月后避免堆积）
  const keep = new Set([...Object.keys(summary.index).map((c) => `${c}.json`), 'index.json'])
  for (const f of readdirSync(dir)) {
    if (!keep.has(f) && existsSync(join(dir, f))) {
      try {
        writeFileSync(join(dir, f), '', 'utf8')
      } catch {
        /* ignore */
      }
    }
  }
  return summary
}
