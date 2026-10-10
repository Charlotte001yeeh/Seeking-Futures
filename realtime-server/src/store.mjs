/**
 * 落库与产物输出（docs/10 §2.4 节流）。
 *
 * 三类写入，全部落在**本服务自己的目录**：
 *   · <outDir>/盘中实时.md / .csv    每次刷新覆盖（人看 + 前端可直读）
 *   · <varDir>/intraday-YYYYMMDD.jsonl  节流落库（默认 ≥10s 或某品种变化 ≥0.05pct）
 *   · <varDir>/today-rank.json        当日首次/最后排名，用于算 rank_change
 *
 * 不写 SQLite：本服务零三方依赖，JSONL 可被后续入库脚本直接消费（docs/10 §2.4 的
 * intraday_rank20 表就是它的下游）。
 */
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.mjs'

export class Store {
  constructor() {
    this.lastStoreAt = 0
    this.lastPct = new Map()
    this.storedCount = 0
    this.jsonlPath = ''
    mkdirSync(config.varDir, { recursive: true })
    mkdirSync(config.outDir, { recursive: true })
  }

  /** 是否该落库：时间到了，或某品种涨跌幅变化超过阈值 */
  shouldStore(snap, now = Date.now()) {
    if (now - this.lastStoreAt >= config.store.minIntervalMs) return true
    for (const r of snap.all) {
      const prev = this.lastPct.get(r.variety)
      if (prev === undefined || Math.abs(prev - r.pct_20d) >= config.store.pctDelta) return true
    }
    return false
  }

  /** 节流落库当天榜单 */
  persist(snap, { force = false, tag = 'intraday' } = {}) {
    const now = Date.now()
    if (!force && !this.shouldStore(snap, now)) return false
    this.lastStoreAt = now
    for (const r of snap.all) this.lastPct.set(r.variety, r.pct_20d)
    const date = snap.tradeDate || 'unknown'
    this.jsonlPath = join(config.varDir, `intraday-${date}.jsonl`)
    const line =
      JSON.stringify({
        ts: new Date(now).toISOString(),
        tag,
        seq: snap.seq,
        trade_date: snap.tradeDate,
        base_date: snap.baseDate,
        quote_time: snap.quoteTime,
        live_count: snap.liveCount,
        total: snap.total,
        rows: snap.gainers.map(compact).concat(snap.losers.map(compact)),
      }) + '\n'
    try {
      appendFileSync(this.jsonlPath, line)
      this.storedCount++
    } catch {
      /* 落库失败不影响推送 */
    }
    return true
  }

  /** 覆盖写人看的产物 */
  writeHumanFiles(snap) {
    try {
      writeFileSync(join(config.outDir, `${config.rtName}.md`), renderMarkdown(snap), 'utf8')
      writeFileSync(join(config.outDir, `${config.rtName}.csv`), renderCsv(snap), 'utf8')
    } catch {
      /* ignore */
    }
  }

  /**
   * 心跳锁：告诉可能同时存在的其他轮询方（如 rank20-daemon 自带的盘中刷新）
   * 「本服务已在轮询」，避免两处同时打数据源、突破 docs/10 §4.3 的速率闸门。
   * 写在共享数据目录 rank20/ 下，属本服务的合法写入范围。
   */
  heartbeat(extra = {}) {
    try {
      writeFileSync(
        join(config.outDir, '.realtime-server.heartbeat'),
        JSON.stringify({ service: 'realtime-server', pid: process.pid, ts: Date.now(), seq: extra.seq ?? 0 }),
        'utf8',
      )
    } catch {
      /* ignore */
    }
  }

  /** 读回当日已存的排名，用于重启后仍能显示 rank_change */
  loadTodayRank(tradeDate) {
    const p = join(config.varDir, 'today-rank.json')
    try {
      if (!existsSync(p)) return null
      const doc = JSON.parse(readFileSync(p, 'utf8'))
      if (doc.tradeDate !== tradeDate) return null
      return new Map(Object.entries(doc.rank))
    } catch {
      return null
    }
  }

  saveTodayRank(snap) {
    try {
      const rank = {}
      for (const r of snap.all) rank[r.variety] = r.rank
      writeFileSync(
        join(config.varDir, 'today-rank.json'),
        JSON.stringify({ tradeDate: snap.tradeDate, savedAt: new Date().toISOString(), rank }),
        'utf8',
      )
    } catch {
      /* ignore */
    }
  }
}

function compact(r) {
  return {
    rank: r.rank,
    variety: r.variety,
    contract: r.contract,
    pct_20d: r.pct_20d,
    pct_1d: r.pct_1d,
    price: r.price,
    base_settle: r.base_settle,
    base_date: r.base_date,
    is_live: r.is_live,
    source: r.source,
  }
}

const fmt = (v, d = 2, plus = false) => {
  if (v === null || v === undefined) return '—'
  const s = Number(v).toFixed(d)
  return plus && v >= 0 ? `+${s}` : s
}

/** 与守护进程同名同格式，保持人工查看习惯不变 */
export function renderMarkdown(snap) {
  const row = (r) =>
    `| ${r.rank} | **${r.name}** | ${r.contract} | **${fmt(r.pct_20d, 2, true)}%** | ${r.price} | ${r.base_settle} | ${r.base_date}${r.base_shifted ? ' ⚠️前移' : ''} | ${r.is_live ? '●实时' : '○日报'} |`
  const head =
    '| 排名 | 品种 | 主力合约 | 20日涨跌% | 最新价 | 基准结算 | 基准日 | 数据 |\n' +
    '| ---: | --- | --- | ---: | ---: | ---: | --- | --- |'
  return [
    `# 期货 20 日涨跌幅 rank20`,
    '',
    `> 交易日 **${snap.tradeDate}** · 基准日 **${snap.baseDate}** · 生成 ${snap.serverTime.slice(0, 16).replace('T', ' ')}`,
    `> 公式：\`(最新价 − 基准日结算价) / 基准日结算价 × 100\``,
    `> **盘中实时** · 行情时间 ${snap.quoteTime || '—'} · 已换价 ${snap.liveCount}/${snap.total} · seq ${snap.seq}`,
    '',
    '## 【涨幅榜 rank20】',
    '',
    head,
    ...snap.gainers.map(row),
    '',
    '## 【跌幅榜 rank20】',
    '',
    head,
    ...snap.losers.map(row),
    '',
  ].join('\n')
}

export function renderCsv(snap) {
  const head =
    'rank,direction,variety,name,contract,pct_20d,pct_1d,price,base_settle,base_date,volume,oi,oi_change,is_live,quote_time,source'
  const line = (r, dir) =>
    [
      r.rank,
      dir,
      r.variety,
      r.name,
      r.contract,
      r.pct_20d.toFixed(4),
      r.pct_1d === null ? '' : r.pct_1d.toFixed(4),
      r.price,
      r.base_settle,
      r.base_date,
      r.volume ?? '',
      r.oi ?? '',
      r.oi_change ?? '',
      r.is_live ? 1 : 0,
      r.quote_time,
      r.source,
    ]
      .map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v))
      .join(',')
  return [head, ...snap.gainers.map((r) => line(r, 'gain')), ...snap.losers.map((r) => line(r, 'loss'))].join('\n')
}
