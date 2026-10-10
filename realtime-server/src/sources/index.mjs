/**
 * 数据源注册表 + 降级链（docs/10 §2.3）
 *
 * 降级链：主源 → 备源 → 官方日报（由 base.json 承担）
 *
 * ⚠️ 实测结论（2026-09-18，本机）：
 *   腾讯 `qt.gtimg.cn` 期货全线返回 `v_pv_none_match="1"`（无期货数据）；
 *   东财 `push2.eastmoney.com` 从本机不可达（fetch failed）。
 *   因此**目前只有新浪一个已打通的工作源**，降级链的第二级实际落到"官方日报快照"。
 *   QuoteSource 接口已按可插拔设计，备源一旦打通只需 register() 一行即可接入。
 */
import { log } from '../log.mjs'
import { sinaSource } from './sina.mjs'

/** @type {Array<object>} 按优先级排列的工作源 */
const sources = []
/** 已声明但不可用的源（用于健康面板透明展示） */
export const unavailableSources = []

export function register(src) {
  sources.push(src)
}

export function activeSources() {
  return sources
}

// 主源
register(sinaSource)

/**
 * 带降级链的取价。
 *
 * @param {string[]} contracts
 * @param {{timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, sourceId:string|null, quotes:Map<string,object>, errors:string[]}>}
 */
export async function fetchQuotes(contracts, opts = {}) {
  const errors = []
  for (const src of sources) {
    try {
      const quotes = await src.fetch(contracts, opts)
      // 覆盖率过低也视为失败（源改版/被限流的典型表现）
      const covered = quotes.size
      const expect = contracts.filter((c) => !src.unsupported?.(c)).length
      const rate = expect > 0 ? covered / expect : 1
      if (rate < 0.5) {
        errors.push(`${src.id}: 覆盖率过低 ${covered}/${expect}`)
        log.warn(`源 ${src.id} 覆盖率 ${(rate * 100).toFixed(0)}%，尝试下一个源`)
        continue
      }
      return { ok: true, sourceId: src.id, quotes, errors }
    } catch (e) {
      const msg = `${src.id}: ${e instanceof Error ? e.message : String(e)}`
      errors.push(msg)
      log.warn(`源 ${src.id} 取价失败：${msg}`)
    }
  }
  return { ok: false, sourceId: null, quotes: new Map(), errors }
}
