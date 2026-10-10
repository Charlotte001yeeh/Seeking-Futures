/**
 * realtime-server —— 集中配置（对应 docs/10 §2.2 节拍策略、§4.3 流量闸门）
 *
 * 所有路径都落在**本服务自己的工作区**内：
 *   · 读  <workspace>/rank20/base.json        （rank20-daemon 每日产出的基准表，单向数据依赖）
 *   · 写  <workspace>/rank20/                 （人看的产物：盘中实时.md / .csv）
 *   · 写  <realtime-server>/var/              （服务自己的日志与落库）
 * 不触碰 ~/.dsh/profiles/**，不写任何业务无关目录。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** realtime-server/ */
export const SERVICE_ROOT = resolve(here, '..')
/** <workspace>/ */
export const WORKSPACE = resolve(SERVICE_ROOT, '..')

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

export const config = {
  host: process.env.RT_HOST ?? '0.0.0.0',
  port: num(process.env.RT_PORT, 8899),

  workspace: WORKSPACE,
  /** 基准表（唯一输入，由 rank20-daemon 每日产出） */
  baseFile: process.env.RT_BASE ?? join(WORKSPACE, 'rank20', 'base.json'),
  /** 人看的产物目录 */
  outDir: process.env.RT_OUT ?? join(WORKSPACE, 'rank20'),
  /** 服务自己的目录（日志 / 落库 / 状态） */
  varDir: process.env.RT_VAR ?? join(SERVICE_ROOT, 'var'),
  webDir: join(SERVICE_ROOT, 'web'),

  poll: {
    /** 主节拍。实测源约 500ms 一拍（docs/10 §1.1），1.5s 与之为 3:1，稳定覆盖每一拍 */
    intervalMs: num(process.env.RT_INTERVAL_MS, 1500),
    /** 连续无变化后退避到的节拍 */
    backoffMs: num(process.env.RT_BACKOFF_MS, 5000),
    /** 连续多少轮「无任何合约变化」即进入退避 */
    idleRoundsToBackoff: num(process.env.RT_IDLE_ROUNDS, 10),
    timeoutMs: num(process.env.RT_TIMEOUT_MS, 5000),
  },

  /** 流量闸门（硬约束，超过即强制延长节拍） */
  gates: {
    maxReqPerSec: num(process.env.RT_MAX_RPS, 1),
    maxReqPerMin: num(process.env.RT_MAX_RPM, 60),
    maxReqPerDay: num(process.env.RT_MAX_RPD, 40000),
  },

  /** 熔断与降级（docs/10 §2.3） */
  failover: {
    errorStreak: num(process.env.RT_ERR_STREAK, 3),
    minSuccessRate: 0.8,
    backoffStepsMs: [3000, 10000, 30000, 60000],
  },

  /** 落库节流（docs/10 §2.4） */
  store: {
    minIntervalMs: num(process.env.RT_STORE_MS, 10000),
    pctDelta: 0.05,
  },

  heartbeatMs: 15000,
  /** 行情时间落后本地超过此值 → 前端出「数据可能陈旧」告警 */
  staleMs: 30000,
  /** 收盘后仍允许用最后一份快照服务多久 */
  closedGraceMs: 30 * 60 * 1000,

  /** 输出文件名（与旧的守护进程产物同名，前端与人工查看路径不变） */
  rtName: process.env.RT_NAME ?? '盘中实时',
}

/**
 * 是否在可交易时段（本地时区）。宽区间判断，取不到行情的合约自然被跳过。
 * 商品日盘 09:00–11:30 / 13:30–15:00；夜盘 21:00–次日 02:30；
 * 中金所股指 09:30–15:00、国债 09:30–15:15（含在宽区间内）。
 */
export function inTradingWindow(now = new Date()) {
  const dow = now.getDay()
  const m = now.getHours() * 60 + now.getMinutes()
  if (dow === 0) return m <= 150 // 周日凌晨仍是周六夜盘尾巴
  if (dow === 6) return m <= 150 // 周六凌晨 = 周五夜盘尾巴
  if (m >= 9 * 60 && m <= 11 * 60 + 30) return true
  if (m >= 13 * 60 && m <= 15 * 60 + 15) return true
  if (m >= 21 * 60) return true
  if (m <= 2 * 60 + 30) return true
  return false
}
