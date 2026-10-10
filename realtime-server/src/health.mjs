/**
 * 数据源健康 + 流量闸门（docs/10 §2.3 熔断 / §4.3 闸门）。
 *
 * 闸门是**硬约束**：任何一次请求前都要先问 canRequest()，
 * 超过速率上限就返回"还要等多久"，调度器据此延长节拍而不是硬闯。
 */
import { config } from './config.mjs'
import { log } from './log.mjs'

export class Health {
  constructor(sourceId) {
    this.sourceId = sourceId
    this.ok = 0
    this.err = 0
    this.streak = 0
    this.state = 'ok' // ok | degraded | down
    this.lastOkAt = null
    this.lastError = null
    this.latencyMs = []
    /** 降级退避档位（config.failover.backoffStepsMs 的下标） */
    this.backoffStep = 0
  }

  recordOk(latencyMs) {
    this.ok++
    this.streak = 0
    this.lastOkAt = new Date().toISOString()
    this.latencyMs.push(latencyMs)
    if (this.latencyMs.length > 50) this.latencyMs.shift()
    if (this.state !== 'ok') log.info(`数据源恢复：${this.sourceId} → ok`)
    this.state = 'ok'
    this.backoffStep = 0
  }

  recordErr(msg) {
    this.err++
    this.streak++
    this.lastError = msg
    const total = this.ok + this.err
    const rate = total > 0 ? this.ok / total : 0
    if (this.streak >= config.failover.errorStreak) {
      this.state = total >= config.failover.errorStreak && rate < config.failover.minSuccessRate ? 'down' : 'degraded'
      this.backoffStep = Math.min(this.backoffStep + 1, config.failover.backoffStepsMs.length - 1)
      log.warn(
        `数据源降级：${this.sourceId} → ${this.state}（连续错误 ${this.streak}，成功率 ${(rate * 100).toFixed(0)}%，退避 ${config.failover.backoffStepsMs[this.backoffStep]}ms）`,
      )
    } else {
      this.state = 'degraded'
    }
  }

  get successRate() {
    const t = this.ok + this.err
    return t === 0 ? 1 : this.ok / t
  }

  get p50Latency() {
    if (!this.latencyMs.length) return null
    const s = [...this.latencyMs].sort((a, b) => a - b)
    return s[s.length >> 1]
  }

  get backoffMs() {
    return this.backoffStep === 0 ? 0 : config.failover.backoffStepsMs[this.backoffStep]
  }

  snapshot() {
    return {
      source: this.sourceId,
      state: this.state,
      ok: this.ok,
      err: this.err,
      errRate: Number((1 - this.successRate).toFixed(4)),
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      p50LatencyMs: this.p50Latency,
      backoffMs: this.backoffMs,
    }
  }
}

/** 滑动窗口限流：1 秒 / 1 分钟 / 当日总量 */
export class Gatekeeper {
  constructor() {
    this.secWindow = []
    this.minWindow = []
    this.dayCount = 0
    this.dayKey = new Date().toISOString().slice(0, 10)
    this.blocked = 0
  }

  #rollDay(now) {
    const key = new Date(now).toISOString().slice(0, 10)
    if (key !== this.dayKey) {
      this.dayKey = key
      this.dayCount = 0
    }
  }

  /**
   * @returns {{allowed:boolean, waitMs:number, reason?:string}}
   */
  canRequest(now = Date.now()) {
    this.#rollDay(now)
    const g = config.gates
    this.secWindow = this.secWindow.filter((t) => now - t < 1000)
    this.minWindow = this.minWindow.filter((t) => now - t < 60000)

    if (this.dayCount >= g.maxReqPerDay) return { allowed: false, waitMs: 60000, reason: 'daily-cap' }
    if (this.minWindow.length >= g.maxReqPerMin) {
      const wait = 60000 - (now - this.minWindow[0]) + 5
      return { allowed: false, waitMs: Math.max(wait, 50), reason: 'per-minute' }
    }
    if (this.secWindow.length >= g.maxReqPerSec) {
      const wait = 1000 - (now - this.secWindow[0]) + 5
      return { allowed: false, waitMs: Math.max(wait, 20), reason: 'per-second' }
    }
    return { allowed: true, waitMs: 0 }
  }

  recordRequest(now = Date.now()) {
    this.#rollDay(now)
    this.secWindow.push(now)
    this.minWindow.push(now)
    this.dayCount++
  }

  snapshot() {
    return {
      limits: config.gates,
      reqLastSec: this.secWindow.length,
      reqLastMin: this.minWindow.length,
      reqToday: this.dayCount,
      blockedCount: this.blocked,
    }
  }
}
