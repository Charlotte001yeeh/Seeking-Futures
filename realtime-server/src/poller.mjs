/**
 * 轮询调度器（docs/10 §2.2 节拍策略）。
 *
 * 状态机：
 *   主节拍 1.5s  ──(连续 10 轮无任何值变化)──▶  退避 5s
 *        ▲                                          │
 *        └────────────(一旦检测到变化)─────────────┘
 *   交易窗口外：不发请求，只做 60s 一次的日历检查
 *   源降级：叠加 §2.3 的退避档位（3s/10s/30s/60s）
 *
 * 每次请求前必须过 Gatekeeper（§4.3 硬闸门）。
 */
import { config, inTradingWindow } from './config.mjs'
import { log } from './log.mjs'
import { fetchQuotes } from './sources/index.mjs'
import { buildSnapshot } from './ranker.mjs'
import { Health, Gatekeeper } from './health.mjs'

export class Poller {
  /**
   * @param {import('./base.mjs').BaseWatcher} baseWatcher
   * @param {import('./snapshot.mjs').SnapshotHub} hub
   * @param {import('./store.mjs').Store} store
   */
  constructor(baseWatcher, hub, store) {
    this.baseWatcher = baseWatcher
    this.hub = hub
    this.store = store
    this.health = new Health('sina')
    this.gates = new Gatekeeper()
    this.idleRounds = 0
    this.cycles = 0
    this.lastSnapshot = null
    this.prevRank = null
    this.timer = null
    this.stopped = false
    this.finalizedFor = null
    this.lastSig = ''
    this.state = 'starting'

    baseWatcher.onReload = (t) => {
      this.prevRank = store.loadTodayRank(t.tradeDate)
    }
  }

  start() {
    this.baseWatcher.refresh()
    this.prevRank = this.store.loadTodayRank(this.baseWatcher.table?.tradeDate ?? '')
    this.#seed()
    this.#schedule(200)
  }

  /**
   * 用基准表播种一份**日报口径**的初始快照。
   *
   * 为什么必须有：休市（周末/节假日/收盘后）时轮询器按设计不发请求，
   * 若内存里没有快照，前端就是一片空白 —— 看板在非交易时段变成不可验收。
   * 这里用 base.json 里各主力合约的最近收盘价先出一版（is_live=false、source=daily_snapshot），
   * 盘中一旦取到实时价就整体覆盖。
   */
  #seed() {
    const base = this.baseWatcher.table
    if (!base || this.hub.current) return
    const snap = buildSnapshot(base, new Map(), {
      sourceId: 'daily_snapshot',
      prevRank: this.prevRank,
      now: new Date(),
    })
    if (!snap.all.length) return
    this.hub.publish(snap)
    this.store.writeHumanFiles(snap)
    this.lastSnapshot = snap
    log.info(
      `已用基准表播种日报口径快照：交易日 ${snap.tradeDate} 基准日 ${snap.baseDate} ${snap.total} 个品种（非实时）`,
    )
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  #schedule(ms) {
    if (this.stopped) return
    this.timer = setTimeout(() => this.#tick(), Math.max(20, ms))
  }

  /** 当前应使用的节拍 */
  #intervalMs() {
    if (!inTradingWindow()) return 60000 // 窗口外只做日历检查，不发请求
    let ms = this.idleRounds >= config.poll.idleRoundsToBackoff ? config.poll.backoffMs : config.poll.intervalMs
    if (this.health.backoffMs > 0) ms = Math.max(ms, this.health.backoffMs)
    return ms
  }

  async #tick() {
    const t0 = Date.now()
    try {
      this.baseWatcher.refresh()
      const base = this.baseWatcher.table

      if (!base) {
        this.state = 'no-base'
        log.warn(`尚未取得基准表：${this.baseWatcher.lastError ?? '文件不存在'}`)
        return this.#schedule(10000)
      }

      // 基准表刚到位（或服务刚起）而内存里还没有快照 → 先播种日报口径，保证前端不空白
      if (!this.hub.current) this.#seed()

      // 交易窗口外：不轮询，改为按日历收盘定稿
      if (!inTradingWindow()) {
        this.state = 'closed'
        await this.#maybeFinalize(base)
        return this.#schedule(60000)
      }

      this.state = 'polling'
      const gate = this.gates.canRequest(t0)
      if (!gate.allowed) {
        this.gates.blocked++
        return this.#schedule(gate.waitMs)
      }

      const contracts = base.rows.map((r) => r.contract)
      this.gates.recordRequest(t0)
      const started = Date.now()
      const res = await fetchQuotes(contracts, { timeoutMs: config.poll.timeoutMs })

      if (!res.ok) {
        this.health.recordErr(res.errors.join('; ') || '全部源失败')
        this.hub.emit('sourceHealth', this.health.snapshot())
        return this.#schedule(this.#intervalMs())
      }
      this.health.recordOk(Date.now() - started)

      const snap = buildSnapshot(base, res.quotes, {
        sourceId: res.sourceId,
        prevRank: this.prevRank,
        now: new Date(),
      })

      // 自适应：本轮是否有任何品种的价格/涨跌幅变化
      const sig = snap.all.map((r) => `${r.variety}:${r.price}`).join('|')
      const changed = sig !== this.lastSig
      this.lastSig = sig
      this.idleRounds = changed ? 0 : this.idleRounds + 1

      this.hub.publish(snap)
      this.store.writeHumanFiles(snap)
      this.store.heartbeat({ seq: snap.seq })
      this.store.persist(snap)
      this.store.saveTodayRank(snap)
      this.prevRank = new Map(snap.all.map((r) => [r.variety, r.rank]))
      this.lastSnapshot = snap
      this.cycles++

      if (this.cycles === 1 || this.cycles % 40 === 0) {
        log.info(
          `第 ${this.cycles} 轮：行情时间 ${snap.quoteTime || '—'} 换价 ${snap.liveCount}/${snap.total} ` +
            `seq=${snap.seq} 涨幅榜首=${snap.gainers[0]?.name} ${snap.gainers[0]?.pct_20d}% ` +
            `${changed ? '' : `（连续 ${this.idleRounds} 轮无变化）`}`,
        )
      }
    } catch (e) {
      log.error(`轮询异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      this.health.recordErr(String(e))
    }
    this.#schedule(this.#intervalMs())
  }

  /** 收盘后写一份定稿快照（每个交易日只做一次） */
  async #maybeFinalize(base) {
    const key = base.tradeDate
    if (this.finalizedFor === key || !this.lastSnapshot) return
    this.finalizedFor = key
    this.store.persist(this.lastSnapshot, { force: true, tag: 'final' })
    this.store.saveTodayRank(this.lastSnapshot)
    log.info(`已写入定稿快照：交易日 ${key}，seq=${this.lastSnapshot.seq}`)
    this.hub.emit('closed', { tradeDate: key, quoteTime: this.lastSnapshot.quoteTime })
  }

  stats() {
    return {
      state: this.state,
      cycles: this.cycles,
      idleRounds: this.idleRounds,
      intervalMs: this.#intervalMs(),
      subscribers: this.hub.subscriberCount,
      pushes: this.hub.pushes,
      dropped: this.hub.dropped,
      gate: this.gates.snapshot(),
      source: this.health.snapshot(),
    }
  }
}
