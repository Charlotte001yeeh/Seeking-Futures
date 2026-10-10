/**
 * 基准表加载与「基准日滚动」。
 *
 * base.json 由 rank20-daemon 每日产出（唯一数据依赖，见 docs/10 §2.1）：
 *   { tradeDate, baseDate, tradingDates[], rows[{variety,name,contract,baseSettle,baseDate,settles{}}] }
 *
 * 盘中若已进入**新的交易日**（实时行情带回来的交易日 > base.json 的 tradeDate），
 * T 与 T−20 都要前移。基准值判定规则与官方一致：**只看结算价**，
 * T−20 有结算价就用；完全没有才回退到最近一个有结算价的交易日。
 */
import { readFileSync, statSync } from 'node:fs'
import { log } from './log.mjs'

/** 基准日回看交易日数（与 rank20-daemon 的 BASE_OFFSET 必须一致） */
export const BASE_OFFSET = 20

function validate(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('base.json 不是对象')
  if (doc.schemaVersion !== 1) throw new Error(`base.json schemaVersion=${doc.schemaVersion}，本服务只认 1`)
  if (!Array.isArray(doc.tradingDates) || doc.tradingDates.length < BASE_OFFSET + 1) {
    throw new Error('base.json tradingDates 不足')
  }
  if (!Array.isArray(doc.rows) || doc.rows.length === 0) throw new Error('base.json rows 为空')
  for (const r of doc.rows) {
    if (!r.variety || !r.contract || !(r.baseSettle > 0) || !r.baseDate) {
      throw new Error(`base.json 行缺少必备字段（铁律）：${JSON.stringify(r).slice(0, 120)}`)
    }
  }
  return doc
}

export class BaseTable {
  constructor(doc, mtimeMs) {
    this.doc = doc
    this.mtimeMs = mtimeMs
    this.tradeDate = doc.tradeDate
    this.baseDate = doc.baseDate
    this.tradingDates = [...doc.tradingDates]
    this.rows = doc.rows
  }

  get generatedAt() {
    return this.doc.generatedAt
  }

  /**
   * 给定实时交易日，解出每个品种应使用的基准。
   * @param {string} liveTradeDate YYYYMMDD
   * @returns {{baseDate:string, byVariety:Map<string,{settle:number,date:string,shifted:boolean,fallback:boolean}>, rolled:boolean}}
   */
  resolveAnchor(liveTradeDate) {
    const byVariety = new Map()
    const cal = this.tradingDates
    const last = cal[cal.length - 1]

    // 未跨日：直接用官方口径（权威值）
    if (!liveTradeDate || liveTradeDate <= last) {
      for (const r of this.rows) {
        byVariety.set(r.variety, { settle: r.baseSettle, date: r.baseDate, shifted: false, fallback: false })
      }
      return { baseDate: this.baseDate, byVariety, rolled: false }
    }

    // 跨日：把日历延伸到「今天」，重算 T−20
    const ext = [...cal, liveTradeDate]
    const anchor = ext[ext.length - 1 - BASE_OFFSET]
    for (const r of this.rows) {
      const settles = r.settles ?? {}
      if (settles[anchor] > 0) {
        byVariety.set(r.variety, { settle: settles[anchor], date: anchor, shifted: false, fallback: false })
        continue
      }
      // 该日无结算价 → 向前找最近一个有结算价的交易日
      let found = null
      for (let i = ext.indexOf(anchor) - 1; i >= 0; i--) {
        const d = ext[i]
        if (settles[d] > 0) {
          found = { date: d, settle: settles[d] }
          break
        }
      }
      if (found) {
        byVariety.set(r.variety, { settle: found.settle, date: found.date, shifted: true, fallback: false })
      } else {
        // 新挂牌合约在该窗口内无任何结算价 → 退回官方基准并显式标记
        byVariety.set(r.variety, {
          settle: r.baseSettle,
          date: r.baseDate,
          shifted: false,
          fallback: true,
        })
      }
    }
    return { baseDate: anchor, byVariety, rolled: true }
  }
}

/** 读取并校验 base.json */
export function loadBaseTable(path) {
  const raw = readFileSync(path, 'utf8')
  const doc = validate(JSON.parse(raw))
  const mtimeMs = statSync(path).mtimeMs
  return new BaseTable(doc, mtimeMs)
}

/**
 * 基准表监视器：每次轮询前比对 mtime，变化则热加载（daemon 09:00 跑完即自动生效）。
 */
export class BaseWatcher {
  constructor(path, onReload) {
    this.path = path
    this.onReload = onReload
    this.table = null
    this.lastMtime = 0
    this.lastError = null
  }

  /** @returns {boolean} 是否发生了重载 */
  refresh() {
    try {
      const m = statSync(this.path).mtimeMs
      if (m === this.lastMtime && this.table) return false
      const t = loadBaseTable(this.path)
      const prev = this.table
      this.table = t
      this.lastMtime = m
      this.lastError = null
      if (prev) {
        log.info(
          `基准表已重载：交易日 ${prev.tradeDate} → ${t.tradeDate}，基准日 ${prev.baseDate} → ${t.baseDate}，${t.rows.length} 个品种`,
        )
      } else {
        log.info(`基准表已加载：交易日 ${t.tradeDate}，基准日 ${t.baseDate}，${t.rows.length} 个品种`)
      }
      this.onReload?.(t, prev)
      return true
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      log.warn(`基准表加载失败：${this.lastError}`)
      return false
    }
  }
}
