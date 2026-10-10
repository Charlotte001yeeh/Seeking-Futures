/**
 * 六交易所抓取器。
 *
 * 全部为官方源：
 *   SHFE  https://www.shfe.com.cn/data/tradedata/future/dailydata/kx{YYYYMMDD}.dat
 *   INE   https://www.ine.cn/data/tradedata/future/dailydata/kx{YYYYMMDD}.dat
 *   CZCE  https://www.czce.com.cn/cn/DFSStaticFiles/Future/{YYYY}/{YYYYMMDD}/FutureDataDaily.txt
 *   GFEX  POST http://www.gfex.com.cn/u/interfacesWebTiDayQuotes/loadList（需 Origin/Referer）
 *   CFFEX http://www.cffex.com.cn/sj/hqsj/rtj/{YYYYMM}/{DD}/{YYYYMMDD}_1.csv
 *   DCE   POST /dceapi/forward/publicweb/dailystat/dayQuotes（apikey + Bearer token）
 */
import { httpJson, httpText, sleep, CancelledError } from './net.js'
import { dceCredentials } from './env.js'
import { type DayBar, type SettleMap } from './types.js'

/** 容错数值解析：剔除千分位、处理空值/'-' */
export function num(v: unknown): number {
  const t = String(v ?? '').trim().replace(/,/g, '')
  if (t === '' || t === '-') return NaN
  const f = Number.parseFloat(t)
  return Number.isFinite(f) ? f : NaN
}

function put(map: SettleMap, d: string, code: string, bar: DayBar): void {
  if (!code) return
  const day = (map[d] ??= {})
  day[code.toLowerCase()] = bar
}

// ─────────────────────────── 上期所 SHFE ───────────────────────────
interface ShfeRow {
  DELIVERYMONTH?: string
  PRODUCTGROUPID?: string
  OPENPRICE?: unknown
  HIGHESTPRICE?: unknown
  LOWESTPRICE?: unknown
  CLOSEPRICE?: unknown
  SETTLEMENTPRICE?: unknown
  PRESETTLEMENTPRICE?: unknown
  VOLUME?: unknown
  OPENINTEREST?: unknown
  ZD1_CHG?: unknown
  TURNOVER?: unknown
}
interface ShfeDoc {
  o_curinstrument?: ShfeRow[]
}

async function fetchShfe(map: SettleMap, d: string, signal?: AbortSignal): Promise<number> {
  const url = `https://www.shfe.com.cn/data/tradedata/future/dailydata/kx${d}.dat`
  const doc = await httpJson<ShfeDoc>(url, { signal })
  let n = 0
  for (const x of doc.o_curinstrument ?? []) {
    if (x.DELIVERYMONTH === '小计') continue
    const close = num(x.CLOSEPRICE)
    const settle = num(x.SETTLEMENTPRICE)
    if (!Number.isFinite(close) || !Number.isFinite(settle)) continue
    const pg = String(x.PRODUCTGROUPID ?? '')
    if (!pg) continue
    put(map, d, pg + x.DELIVERYMONTH, {
      d, close, settle,
      open: num(x.OPENPRICE),
      high: num(x.HIGHESTPRICE),
      low: num(x.LOWESTPRICE),
      turnover: num(x.TURNOVER), // 单位：万元
      vol: num(x.VOLUME) || 0,
      oi: num(x.OPENINTEREST) || 0,
    })
    n++
  }
  return n
}

// ────────────────────────── 能源中心 INE ──────────────────────────
async function fetchIne(map: SettleMap, d: string, signal?: AbortSignal): Promise<number> {
  const url = `https://www.ine.cn/data/tradedata/future/dailydata/kx${d}.dat`
  const doc = await httpJson<ShfeDoc>(url, { signal })
  let n = 0
  for (const x of doc.o_curinstrument ?? []) {
    if (x.DELIVERYMONTH === '小计') continue
    const pg = String(x.PRODUCTGROUPID ?? '')
    // 剔除 sc_tas 之类带下划线的特殊合约
    if (pg.includes('_')) continue
    const close = num(x.CLOSEPRICE)
    const settle = num(x.SETTLEMENTPRICE)
    if (!Number.isFinite(close) || !Number.isFinite(settle)) continue
    put(map, d, pg + x.DELIVERYMONTH, {
      d, close, settle,
      open: num(x.OPENPRICE),
      high: num(x.HIGHESTPRICE),
      low: num(x.LOWESTPRICE),
      turnover: num(x.TURNOVER), // 单位：万元
      vol: num(x.VOLUME) || 0,
      oi: num(x.OPENINTEREST) || 0,
    })
    n++
  }
  return n
}

// ────────────────────────── 郑商所 CZCE ──────────────────────────
// 管道分隔 14 列：合约|昨结算|今开|最高|最低|今收|今结|涨跌1|涨跌2|成交量|持仓量|增减|成交额|交割结算价
async function fetchCzce(map: SettleMap, d: string, signal?: AbortSignal): Promise<number> {
  const url = `https://www.czce.com.cn/cn/DFSStaticFiles/Future/${d.slice(0, 4)}/${d}/FutureDataDaily.txt`
  const text = await httpText(url, { signal })
  let n = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('|')) continue
    const c = line.split('|').map((s) => s.trim())
    if (c.length < 11) continue
    const code = c[0]!
    if (!/^[A-Z]{1,4}\d{3,4}$/.test(code)) continue // 天然跳过"小计"/"总计"
    const close = num(c[5])
    const settle = num(c[6])
    // ⚠️ 郑商所对**未成交**合约也发布行，但 今收盘 = 0、今结算 有值（如 JR701 收 0 结 2662）。
    //    这里必须保留这类行：20 日涨跌幅的基准日是「按结算价」判定的，
    //    若把 close=0 的行一并丢掉，会误判成"该日没有结算价"而错误回退基准日。
    //    是否可以参与排名由 computeRank20 的 `today.close > 0 && today.vol > 0` 决定。
    if (!Number.isFinite(settle) || settle === 0) continue
    if (!Number.isFinite(close)) continue
    put(map, d, code, {
      d, close, settle,
      open: num(c[2]),
      high: num(c[3]),
      low: num(c[4]),
      turnover: num(c[12]), // 单位：万元
      vol: num(c[9]) || 0,
      oi: num(c[10]) || 0,
    })
    n++
  }
  return n
}

// ────────────────────────── 广期所 GFEX ──────────────────────────
interface GfexRow {
  variety?: string
  varietyOrder?: string
  delivMonth?: string
  open?: unknown
  high?: unknown
  low?: unknown
  close?: unknown
  clearPrice?: unknown
  lastClear?: unknown
  volumn?: unknown // ⚠️ 官方字段就是拼错的 volumn
  openInterest?: unknown
  turnover?: unknown
}
interface GfexDoc {
  code?: string
  data?: GfexRow[]
}

async function fetchGfex(map: SettleMap, d: string, signal?: AbortSignal): Promise<number> {
  const doc = await httpJson<GfexDoc>('http://www.gfex.com.cn/u/interfacesWebTiDayQuotes/loadList', {
    method: 'POST',
    body: `trade_date=${d}&trade_type=0`,
    headers: {
      Origin: 'http://www.gfex.com.cn',
      Referer: 'http://www.gfex.com.cn/gfex/rihq/hqsj_tjsj.shtml',
      'X-Requested-With': 'XMLHttpRequest',
    },
    retries: 4,
    signal,
  })
  if (doc.code !== '0') return 0
  let n = 0
  for (const x of doc.data ?? []) {
    if (!x.varietyOrder || !x.delivMonth) continue // 跳过"总计"行
    const close = num(x.close)
    const settle = num(x.clearPrice)
    if (!Number.isFinite(close) || !Number.isFinite(settle)) continue
    put(map, d, x.varietyOrder + x.delivMonth, {
      d, close, settle,
      open: num(x.open),
      high: num(x.high),
      low: num(x.low),
      turnover: num(x.turnover),
      vol: num(x.volumn) || 0,
      oi: num(x.openInterest) || 0,
    })
    n++
  }
  return n
}

// ────────────────────────── 中金所 CFFEX ──────────────────────────
// CSV 列：0=合约 1=开 2=高 3=低 4=成交量 5=成交额 6=持仓 7=持仓变化
//         8=今结算 9=昨结算 10=前结算 11=涨跌1 12=涨跌2 13=Delta
// ⚠️ 该 CSV 不含收盘价列 → 以结算价代价格
async function fetchCffex(map: SettleMap, d: string, signal?: AbortSignal): Promise<number> {
  const url = `http://www.cffex.com.cn/sj/hqsj/rtj/${d.slice(0, 6)}/${d.slice(6, 8)}/${d}_1.csv`
  const text = await httpText(url, { signal })
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  let n = 0
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i]!.split(',')
    if (c.length < 11) continue
    const code = (c[0] ?? '').trim()
    if (!/^(IF|IC|IH|IM|T|TF|TS|TL)\d{4}$/.test(code)) continue
    const settle = num(c[8])
    if (!Number.isFinite(settle) || settle === 0) continue
    put(map, d, code, {
      // ⚠️ 中金所日报**没有收盘价列**，以结算价代价格（下游标注 src=eod_settle_as_close）
      d, close: settle, settle,
      open: num(c[1]),
      high: num(c[2]),
      low: num(c[3]),
      turnover: num(c[5]), // 单位：万元
      vol: num(c[4]) || 0,
      oi: num(c[6]) || 0,
    })
    n++
  }
  return n
}

// ────────────────────────── 大商所 DCE（官方 API）──────────────────────────
interface DceAuth {
  success?: boolean
  data?: { token?: string }
}
interface DceQuote {
  variety?: string
  contractId?: string
  open?: unknown
  high?: unknown
  low?: unknown
  close?: unknown
  clearPrice?: unknown
  lastClear?: unknown
  volumn?: unknown
  openInterest?: unknown
  turnover?: unknown
}
interface DceDoc {
  success?: boolean
  data?: DceQuote[]
}

let dceToken: string | null = null
let dceTokenAt = 0
const TOKEN_TTL = 7 * 3600 * 1000 // 实际 8 小时，留 1 小时余量

async function dceLogin(signal?: AbortSignal): Promise<string> {
  if (dceToken && Date.now() - dceTokenAt < TOKEN_TTL) return dceToken
  // 凭据只在调用时从环境变量/.env 取（源码里不留任何真实值）
  const { apiKey, secret, host } = dceCredentials()
  const text = await httpText(`http://${host}/dceapi/cms/auth/accessToken`, {
    method: 'POST',
    body: JSON.stringify({ secret }),
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    retries: 4,
    signal,
  })
  const doc = JSON.parse(text) as DceAuth
  const token = doc.data?.token
  if (!token) throw new Error(`DCE 登录失败: ${text.slice(0, 200)}`)
  dceToken = token
  dceTokenAt = Date.now()
  return token
}

/** DCE 单次请求的合约数下限（正常约 250 个；低于此值判定为响应不完整） */
const DCE_MIN_ROWS = 180

async function fetchDce(map: SettleMap, d: string, signal?: AbortSignal): Promise<number> {
  const { apiKey, host } = dceCredentials()
  const token = await dceLogin(signal)
  // 带完整性校验：响应被截断/限流时重试，避免单日数据缺失造成品种被误判
  let lastCount = 0
  for (let attempt = 1; attempt <= 4; attempt++) {
    await sleep(attempt === 1 ? 0 : 2600, signal)
    const text = await httpText(`http://${host}/dceapi/forward/publicweb/dailystat/dayQuotes`, {
      method: 'POST',
      // ⚠️ 字段名必须是 varietyId；写成 variety 会返回 401「无权限访问该接口」
      body: JSON.stringify({ varietyId: 'all', tradeDate: d, tradeType: '1', lang: 'zh' }),
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      retries: 2,
      signal,
    })
    let doc: DceDoc
    try {
      doc = JSON.parse(text) as DceDoc
    } catch {
      lastCount = 0
      continue
    }
    const rows = (doc.data ?? []).filter((x) =>
      /^[a-z]{1,2}\d{4}f?$/i.test(String(x.contractId ?? '')),
    )
    if (!doc.success || rows.length < DCE_MIN_ROWS) {
      lastCount = rows.length
      continue // 响应不完整，重试
    }
    let n = 0
    for (const x of rows) {
      const id = String(x.contractId)
      const close = num(x.close)
      const settle = num(x.clearPrice)
      if (!Number.isFinite(close) || !Number.isFinite(settle)) continue
      // ⚠️ 正则必须容纳月均价 F 后缀，否则聚丙烯/聚乙烯月均价会漏掉
      put(map, d, id, {
        d, close, settle,
        open: num(x.open),
        high: num(x.high),
        low: num(x.low),
        turnover: num(x.turnover), // 单位：万元
        vol: num(x.volumn) || 0,
        oi: num(x.openInterest) || 0,
      })
      n++
    }
    return n
  }
  throw new Error(`DCE 数据不完整（有效合约数 ${lastCount} < ${DCE_MIN_ROWS}），已重试 4 次`)
}

// ────────────────────────── 编排 ──────────────────────────

type Fetcher = (map: SettleMap, d: string, signal?: AbortSignal) => Promise<number>

/**
 * 各源端点模板（`{d}`=YYYYMMDD，`{y}`=YYYY，`{ym}`=YYYYMM，`{dd}`=DD）。
 * 供状态面板展示与连通性探测使用 —— 与各抓取器里实际拼接的 URL 一一对应。
 */
export const EXCHANGE_ENDPOINTS: Record<string, string> = {
  SHFE: 'https://www.shfe.com.cn/data/tradedata/future/dailydata/kx{d}.dat',
  INE: 'https://www.ine.cn/data/tradedata/future/dailydata/kx{d}.dat',
  CZCE: 'https://www.czce.com.cn/cn/DFSStaticFiles/Future/{y}/{d}/FutureDataDaily.txt',
  GFEX: 'http://www.gfex.com.cn/u/interfacesWebTiDayQuotes/loadList',
  CFFEX: 'http://www.cffex.com.cn/sj/hqsj/rtj/{ym}/{dd}/{d}_1.csv',
  DCE: 'http://www.dce.com.cn/dceapi/forward/publicweb/dailystat/dayQuotes',
}

/** 端点模板 → 实际 URL（供状态面板显示真实地址） */
export function expandEndpoint(tpl: string, d: string): string {
  return tpl
    .replace('{d}', d)
    .replace('{y}', d.slice(0, 4))
    .replace('{ym}', `${d.slice(0, 4)}${d.slice(4, 6)}`)
    .replace('{dd}', d.slice(6, 8))
}

const FETCHERS: Array<{ name: string; fn: Fetcher }> = [
  { name: 'SHFE', fn: fetchShfe },
  { name: 'INE', fn: fetchIne },
  { name: 'CZCE', fn: fetchCzce },
  { name: 'GFEX', fn: fetchGfex },
  { name: 'CFFEX', fn: fetchCffex },
  { name: 'DCE', fn: fetchDce },
]

/** 交易日候选（最近 n 个工作日，含节假日；节假日抓取会返回空并被跳过） */
export function recentWorkdays(n: number, from = new Date()): string[] {
  const out: string[] = []
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()))
  while (out.length < n) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) {
      out.push(
        `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`,
      )
    }
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return out.reverse()
}

/** 具名导出各交易所抓取器（供状态面板做**真实**连通性探测，复用同一套解析器） */
export const EXCHANGE_FETCHERS = FETCHERS

/**
 * 抓取最近若干工作日的全交易所数据。
 * @param days 需要的交易日数（建议 ≥ 26，保证能找到 T−20）
 * @param log  日志回调
 * @param signal 取消信号
 * @param from 窗口锚点（"最后一天"，默认今天）。
 *   固定 cutoff 的历史复算**必须**显式传入 cutoff，否则窗口会随真实日期漂移：
 *   32 个工作日的窗口一直在往前挪，某天起就再也盖不住 cutoff 之前的那 21 个交易日，
 *   表现为"品种数=0 / 交易日不足"的假失败（2026-10-10 实测踩到）。
 */
export async function fetchAllExchanges(
  days: number,
  log: (msg: string) => void = () => {},
  signal?: AbortSignal,
  from?: Date,
): Promise<SettleMap> {
  const candidates = recentWorkdays(days, from ?? new Date())
  const map: SettleMap = {}
  const stats: Record<string, number> = {}
  /** 每个日期的分交易所行数（用于判定"六所是否齐全"） */
  const perDate: Record<string, Record<string, number>> = {}

  for (const d of candidates) {
    if (signal?.aborted) throw new CancelledError('fetchAllExchanges aborted')
    let dayTotal = 0
    let isTradingDay = false
    const counts = (perDate[d] ??= {})
    for (const { name, fn } of FETCHERS) {
      if (signal?.aborted) throw new CancelledError('fetchAllExchanges aborted')
      try {
        const n = await fn(map, d, signal)
        counts[name] = n
        stats[name] = (stats[name] ?? 0) + n
        dayTotal += n
        if (n > 0) isTradingDay = true
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        counts[name] = 0
        // HTTP 404 = 该交易所当日文件尚未发布（收盘前/非交易日），按"暂无数据"处理
        if (!/HTTP 404/.test(msg)) {
          log(`  ⚠️ ${d} ${name} 抓取失败: ${msg}`)
        }
      }
    }
    if (isTradingDay) {
      const contracts = Object.keys(map[d] ?? {}).length
      log(`  ✅ ${d} 交易日，${contracts} 个合约（本次新增 ${dayTotal} 行）`)
    } else {
      // 非交易日：清掉空壳
      delete map[d]
      delete perDate[d]
    }
    await sleep(80, signal)
  }

  // ── 前沿修剪：最新日期必须是"六所全部已发布"的完整交易日。
  //    交易所在收盘后才陆续发布日报，若在发布过程中运行，最新日期会只有
  //    部分交易所的数据（例：2026-09-17 15:42 时 CZCE 尚未出，仅 56 个品种），
  //    据此计算的榜单会整体错误。此时退回上一个完整交易日。
  const kept = Object.keys(map).sort()
  for (let i = kept.length - 1; i >= 0; i--) {
    const d = kept[i]!
    const counts = perDate[d] ?? {}
    const missing = FETCHERS.filter((f) => (counts[f.name] ?? 0) === 0).map((f) => f.name)
    if (missing.length === 0) break
    log(`  ⏭ ${d} 仅 ${FETCHERS.length - missing.length}/${FETCHERS.length} 所已发布（缺 ${missing.join('/')}），判定为未完成数据，不予采用`)
    delete map[d]
    delete perDate[d]
  }

  log(`  数据源累计：${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  return map
}
