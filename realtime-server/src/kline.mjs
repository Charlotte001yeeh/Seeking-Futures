/**
 * K 线读取 + 实时滚动最后一根。
 *
 * 数据由 rank20-daemon / standalone 的每日任务产出（<outDir>/kline/<合约>.json），
 * 官方日报窗口优先，新浪补更早历史（见 rank20-daemon/src/kline.ts）。
 *
 * 本模块只做两件事：
 *   1. 读盘 + 内存缓存（前端展开时才请求，避免首屏成本）
 *   2. 用实时行情滚动"正在形成的那一根"，并保证**官方根永不被实时值覆盖**
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.mjs'
import { log } from './log.mjs'

export class KlineStore {
  constructor(outDir = config.outDir) {
    this.dir = join(outDir, 'kline')
    /** @type {Map<string, {doc:object, mtimeMs:number}>} */
    this.cache = new Map()
    this.hits = 0
    this.misses = 0
  }

  /** 读某合约的 K 线；文件变化会自动重读 */
  get(contract) {
    if (!contract) return null
    const p = join(this.dir, `${contract}.json`)
    if (!existsSync(p)) {
      this.misses++
      return null
    }
    try {
      const m = statSync(p).mtimeMs
      const c = this.cache.get(contract)
      if (c && c.mtimeMs === m) {
        this.hits++
        return c.doc
      }
      const doc = JSON.parse(readFileSync(p, 'utf8'))
      this.cache.set(contract, { doc, mtimeMs: m })
      this.hits++
      return doc
    } catch (e) {
      log.warn(`读取 K 线失败 ${contract}：${e instanceof Error ? e.message : e}`)
      return null
    }
  }

  stats() {
    return { dir: this.dir, cached: this.cache.size, hits: this.hits, misses: this.misses }
  }
}

/**
 * 把实时行情滚动到最后一根上。
 *
 * 规则（daily_k.md §2.6）：
 *   liveD >  last.d  → **追加**一根 forming bar（o/h/l/c/v/oi 全部来自实时字段）
 *   liveD == last.d  → 原地更新 h=max、l=min、c=最新、v/oi=实时
 *   liveD <  last.d  → 忽略（脏数据/跨源回退）
 *   last 是官方根（src 以 eod 开头）→ **绝不覆盖**（官方是权威）
 *
 * @param {object} doc   KlineStore 读出的文档
 * @param {object|null} live  {tradeDay, open, high, low, price, volume, oi} —— 来自实时行情
 * @returns {object} 新的 K 线文档（浅拷贝 + 新 bars 数组；不改缓存对象）
 */
export function applyLiveBar(doc, live) {
  if (!doc?.bars?.length) return doc
  if (!live || !(live.price > 0)) return doc

  const liveD = String(live.tradeDay ?? '').replace(/[^\d]/g, '')
  const bars = doc.bars
  const last = bars[bars.length - 1]

  // 官方根是权威，实时值不得覆盖
  const lastIsOfficial = String(last.src ?? '').startsWith('eod')
  if (!/^\d{8}$/.test(liveD)) return doc

  const forming = {
    d: liveD,
    o: numOr(live.open, last.c),
    h: numOr(live.high, live.price),
    l: numOr(live.low, live.price),
    c: live.price,
    s: 0,
    v: numOr(live.volume, 0),
    oi: numOr(live.oi, 0),
    src: 'live',
  }

  if (liveD > last.d) {
    return { ...doc, bars: [...bars, forming], liveBarDate: liveD }
  }
  if (liveD === last.d) {
    if (lastIsOfficial) return { ...doc, liveBarDate: liveD }
    const updated = {
      ...last,
      // 开：以第一次拿到的为准（同一交易日内不变）
      o: last.src === 'live' ? last.o : forming.o,
      h: Math.max(last.h ?? last.c, forming.h),
      l: Math.min(last.l ?? last.c, forming.l),
      c: live.price,
      v: forming.v,
      oi: forming.oi,
      src: 'live',
    }
    return { ...doc, bars: [...bars.slice(0, -1), updated], liveBarDate: liveD }
  }
  return doc // liveD < last.d → 忽略
}

function numOr(v, d) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}
