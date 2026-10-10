/**
 * 硬逻辑推导（**规则版 v1，全部来自真实数据，不编造**）
 *
 * 重要说明：
 *   · 本模块**不是模型**。D4 的分析层（LLM 因果归因）尚未接入。
 *   · 这里输出的每一条结论都由**可复核的数值**推导，并附 `evidence`（含数值与来源）。
 *   · 字段 `generatedBy: "rules-v1"` 与 `modelConnected: false` 会让前端明确标注
 *     "规则推导 · 模型层未接入"，绝不把规则输出冒充成模型判断。
 *   · 缺数据时对应条目**直接不产生**（例如没有 K 线就不给"确认日"），不猜、不补。
 *
 * 推导项：
 *   方向        20 日涨跌幅符号
 *   趋势        20 日涨跌幅 + 基准价 → 最新价
 *   当日动能    当日涨跌幅（与 20 日同向 / 背离）
 *   持仓        持仓量变化（增仓/减仓 × 上行/下行 → 多空增仓语义）
 *   量能        最新成交量 / 近 20 日均量
 *   板块共振    同板块上榜品种的同向数量
 *   龙头地位    同板块同向内 |20日涨跌幅| 最大
 *   确认日      最近一次创近 20 日收盘新高/新低（需 K 线）
 *   失效条件    跌破基准日结算价 / 跌破近 20 日最低收盘（需 K 线）
 */
import { sectorOfRow } from './sectors.mjs'

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null)

/**
 * @param {object} row         榜单行（含 pct_20d/pct_1d/price/base_settle/oi/oi_change/volume）
 * @param {object[]} allRows   全部品种行（用于板块共振与龙头判定）
 * @param {object|null} kline  该合约 K 线（{bars:[{d,o,h,l,c,v,oi,src}]}），没有则传 null
 */
export function deriveLogic(row, allRows, kline) {
  const sector = sectorOfRow(row)
  const direction = row.pct_20d > 0 ? 'long' : row.pct_20d < 0 ? 'short' : 'neutral'
  const dirCN = direction === 'long' ? '做多' : direction === 'short' ? '做空' : '中性'
  const evidence = []
  const hard = []

  // ── 1. 20 日趋势（核心，官方基准价）──────────────────────────────────
  evidence.push({
    kind: '趋势',
    label: '20 日涨跌幅',
    value: `${row.pct_20d > 0 ? '+' : ''}${r2(row.pct_20d)}%`,
    source: 'official_eod',
    detail: `基准日 ${row.base_date} 结算价 ${row.base_settle} → 最新价 ${row.price}`,
  })
  hard.push(
    `${dirCN}依据：20 日涨跌幅 ${row.pct_20d > 0 ? '+' : ''}${r2(row.pct_20d)}%` +
      `（基准 ${row.base_date} 结算 ${row.base_settle} → 现价 ${row.price}）`,
  )

  // ── 2. 当日动能 ──────────────────────────────────────────────────────
  if (row.pct_1d !== null && row.pct_1d !== undefined) {
    const aligned = (row.pct_1d > 0 && direction === 'long') || (row.pct_1d < 0 && direction === 'short')
    evidence.push({
      kind: '动能',
      label: '当日涨跌幅',
      value: `${row.pct_1d > 0 ? '+' : ''}${r2(row.pct_1d)}%`,
      source: row.is_live ? 'sina_live' : 'official_eod',
      detail: aligned ? '与 20 日趋势同向' : '与 20 日趋势**背离**',
    })
    hard.push(
      aligned
        ? `当日动能同向：${row.pct_1d > 0 ? '+' : ''}${r2(row.pct_1d)}%，趋势延续`
        : `⚠️ 当日动能背离：${row.pct_1d > 0 ? '+' : ''}${r2(row.pct_1d)}%，与 20 日方向相反，注意反转`,
    )
  }

  // ── 3. 持仓量变化 → 多空增仓语义 ─────────────────────────────────────
  if (row.oi_change !== null && row.oi_change !== undefined && row.oi) {
    const up = row.oi_change > 0
    let sem
    if (direction === 'long') sem = up ? '多头增仓（趋势有资金跟进）' : '多头减仓（上行动能减弱）'
    else if (direction === 'short') sem = up ? '空头增仓（趋势有资金跟进）' : '空头减仓（下行动能减弱）'
    else sem = '方向中性'
    evidence.push({
      kind: '持仓',
      label: '持仓量变化',
      value: `${row.oi_change > 0 ? '+' : ''}${Math.round(row.oi_change)}（现 ${Math.round(row.oi)}）`,
      source: row.is_live ? 'sina_live' : 'official_eod',
      detail: sem,
    })
    hard.push(`持仓 ${row.oi_change > 0 ? '增加' : '减少'} ${Math.abs(Math.round(row.oi_change))} 手 → ${sem}`)
  }

  // ── 4. 量能（需要 K 线才有均量）─────────────────────────────────────
  let ma20Vol = null
  let ma5 = null
  let ma20 = null
  if (kline?.bars?.length) {
    const bars = kline.bars
    const last20 = bars.slice(-20)
    ma20Vol = last20.reduce((a, b) => a + (b.v || 0), 0) / last20.length
    const closes = bars.map((b) => b.c)
    ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, closes.length)
    ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length)
  }
  if (row.volume && ma20Vol) {
    const ratio = row.volume / ma20Vol
    evidence.push({
      kind: '量能',
      label: '成交量 / 近20日均量',
      value: `${ratio.toFixed(2)}×`,
      source: 'derived',
      detail: ratio >= 1.5 ? '显著放量' : ratio <= 0.7 ? '明显缩量' : '量能平稳',
    })
    if (ratio >= 1.5) hard.push(`量能放大 ${ratio.toFixed(2)}×（近 20 日均量），趋势有成交配合`)
    else if (ratio <= 0.7) hard.push(`量能萎缩至 ${ratio.toFixed(2)}×，上行/下行缺乏成交确认`)
  }

  // ── 5/6. 板块共振 + 龙头地位 ─────────────────────────────────────────
  const peers = (allRows ?? []).filter((x) => sectorOfRow(x) === sector && x.variety !== row.variety)
  const sameDir = peers.filter((x) => (direction === 'long' ? x.pct_20d > 0 : x.pct_20d < 0))
  const sortedByAbs = [row, ...peers].sort((a, b) => Math.abs(b.pct_20d) - Math.abs(a.pct_20d))
  const isLeader = sortedByAbs[0]?.variety === row.variety

  evidence.push({
    kind: '板块',
    label: `所属板块：${sector}`,
    value: `同向 ${sameDir.length}/${peers.length} 个上榜品种`,
    source: 'derived',
    detail: '板块分类来自本项目内置分类表（非官方数据）',
  })
  if (sameDir.length >= 3) {
    hard.push(`板块共振：${sector} 内 ${sameDir.length} 个上榜品种与它同向，属板块级行情而非个体波动`)
  }
  if (isLeader) {
    hard.push(`龙头地位：${sector} 板块内 |20日涨跌幅| 第 1（${r2(row.pct_20d)}%），是本轮板块代表`)
    evidence.push({ kind: '龙头', label: '板块内排名', value: '第 1', source: 'derived', detail: '按 |20日涨跌幅| 排序' })
  }

  // ── 7. 确认日（需 K 线；用真实 OHLC 判定）────────────────────────────
  let confirmDate = null
  let confirmNote = 'K 线数据未覆盖，无法判定确认日'
  if (kline?.bars?.length) {
    const bars = kline.bars
    const win = bars.slice(-21, -1) // 前 20 根（不含最后一根）
    const last = bars[bars.length - 1]
    if (win.length >= 5 && last) {
      const hi = Math.max(...win.map((b) => b.c))
      const lo = Math.min(...win.map((b) => b.c))
      if (direction === 'long' && last.c >= hi) {
        confirmDate = last.d
        confirmNote = `收盘 ${last.c} 创近 ${win.length} 日新高（前高 ${hi}）`
      } else if (direction === 'short' && last.c <= lo) {
        confirmDate = last.d
        confirmNote = `收盘 ${last.c} 创近 ${win.length} 日新低（前低 ${lo}）`
      } else {
        // 回溯最近一次创新高/新低
        for (let i = bars.length - 1; i >= 1; i--) {
          const w = bars.slice(Math.max(0, i - 20), i)
          if (w.length < 5) break
          const h = Math.max(...w.map((b) => b.c))
          const l = Math.min(...w.map((b) => b.c))
          if ((direction === 'long' && bars[i].c >= h) || (direction === 'short' && bars[i].c <= l)) {
            confirmDate = bars[i].d
            confirmNote = `最近一次创近 ${w.length} 日${direction === 'long' ? '新高' : '新低'}（收 ${bars[i].c}）`
            break
          }
        }
        if (!confirmDate) confirmNote = `近 20 日未创${direction === 'long' ? '新高' : '新低'}，尚未出现确认日`
      }
    }
  }
  evidence.push({
    kind: '确认日',
    label: '确认日',
    value: confirmDate ?? '无',
    source: kline?.bars?.length ? 'derived' : 'unavailable',
    detail: confirmNote,
  })
  // 诚实性：确认后若价格已反向回落，必须点明"突破未守住"，不能只报确认日
  let confirmCaveat = ''
  if (confirmDate && kline?.bars?.length && row.price > 0) {
    const cb = kline.bars.find((b) => b.d === confirmDate)
    if (cb) {
      if (direction === 'long' && row.price < cb.c) {
        confirmCaveat = `（确认后价格已回落至 ${row.price}，低于确认日收盘 ${cb.c}，突破未守住）`
      } else if (direction === 'short' && row.price > cb.c) {
        confirmCaveat = `（确认后价格已反弹至 ${row.price}，高于确认日收盘 ${cb.c}，破位未延续）`
      }
    }
  }
  if (confirmDate) {
    hard.push(`确认日 ${confirmDate}：${confirmNote}${confirmCaveat}`)
  } else {
    hard.push(`尚无确认日 —— ${confirmNote}`)
  }

  // ── 8. 均线位置（有 K 线时）─────────────────────────────────────────
  if (ma5 && ma20 && row.price) {
    const above5 = row.price >= ma5
    const above20 = row.price >= ma20
    evidence.push({
      kind: '均线',
      label: 'MA5 / MA20',
      value: `${r2(ma5)} / ${r2(ma20)}`,
      source: 'derived',
      detail: `现价${above5 ? '在' : '低于'} MA5、${above20 ? '在' : '低于'} MA20`,
    })
  }

  // ── 9. 失效条件（可机器判定）────────────────────────────────────────
  const invalidation = [
    `跌回基准日 ${row.base_date} 结算价 ${row.base_settle} 之下（20 日涨幅归零）`,
  ]
  if (kline?.bars?.length) {
    const win = kline.bars.slice(-21, -1)
    if (win.length >= 5) {
      const lo = Math.min(...win.map((b) => b.l ?? b.c))
      const hi = Math.max(...win.map((b) => b.h ?? b.c))
      invalidation.push(
        direction === 'long'
          ? `跌破近 20 日最低 ${r2(lo)}（趋势结构破坏）`
          : `站上近 20 日最高 ${r2(hi)}（趋势结构破坏）`,
      )
    }
  }

  return {
    variety: row.variety,
    name: row.name,
    contract: row.contract,
    sector,
    direction,
    directionCN: dirCN,
    /** 明确标注：本结论由规则推导，不是模型判断 */
    generatedBy: 'rules-v1',
    modelConnected: false,
    modelNote: 'D4 分析层（LLM 因果归因）尚未接入；以下结论由真实行情数据按固定规则推导，每条均附证据',
    leader: isLeader,
    confirmDate,
    confirmNote: confirmNote + confirmCaveat,
    hardLogic: hard,
    invalidation,
    evidence,
    updatedAt: new Date().toISOString(),
  }
}
