/**
 * dsh-rank20-daemon
 *
 * 每日定时抓取六交易所官方行情 → 计算 20 日涨跌幅 rank20 → 输出 Markdown/CSV 到工作区。
 *
 * 算法规范：docs/04-总设计.md §3.5.5、docs/09-20日涨跌幅rank20完整版.md
 * 文件：`YYYY年MM月DD日HH时.md` / `.csv`（只含涨幅榜 rank20 + 跌幅榜 rank20）
 *
 * ── 生命周期约定（本轮重写，解决"热重载要等 95s"的问题）────────────────
 *   · 每个实例持有独立 AbortController，dispose 时 abort
 *   · signal 一路透传：fetch → httpText/httpJson → 重试等待 → 限流等待 → 抓取器 → runOnce/runRealtime
 *   · 所有异步任务都进 inFlight 集合（不再有无人管理的 void Promise）
 *   · ctx.effect 注册异步清理：置 stopping → abort → 清定时器 → 带超时等待在途任务
 *   · dispose 后不再写文件 / 不再 arm 定时器 / 不再更新 baseRows / 不再写"运行完成"日志
 *   · 定时器用原生 setTimeout / clearTimeout（不依赖 timer 服务，fiber 不会因未决定时器停在 loading）
 */
import type { Context } from 'cordis'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import z from 'schemastery'
import { fetchAllExchanges } from './exchanges.js'
import { computeRank20, renderCsv, renderMarkdown } from './rank20.js'
import { fetchLiveQuotes, inTradingWindow, sinaSymbol } from './realtime.js'
import { isCancelled } from './net.js'
import { refreshKline, sinaKlineCode } from './kline.js'
import { buildBaseTable, SERIES_DAYS } from './basetable.js'
import { stampName, localDay } from './naming.js'
import type { Rank20Result, RankRow, SettleMap } from './types.js'

export { buildBaseTable, SERIES_DAYS } from './basetable.js'
export { stampName, localDay } from './naming.js'

export const name = 'dsh-rank20-daemon'
/** 不依赖任何服务：定时器用原生实现，避免 fiber 因未决定时器停在 loading */
export const inject: string[] = []

/** ctx.effect 的最小形态（Cordis 提供：注册随 fiber 卸载的清理回调） */
type EffectContext = Context & {
  effect?: (callback: () => void | (() => void | Promise<void>)) => unknown
}

export interface Config {
  /** 每日运行时刻（本地时区小时，0-23） */
  hour: number
  /** 每日运行时刻（分钟，0-59） */
  minute: number
  /** 输出目录（绝对路径；留空则用 workspace） */
  outDir: string
  /** 采集最近多少个工作日（需 ≥ 26 才能覆盖 T−20） */
  lookbackDays: number
  /**
   * 启动时做**幂等检查**：若当天已成功跑过则跳过；否则按 catchUpOnStart 决定是否补跑。
   * 注意：它**不再**表示"每次挂载都立即抓一次"。
   */
  runOnStart: boolean
  /**
   * 是否允许在启动/热重载时补跑当日抓取。默认 **false**：
   * 开发期热重载绝不应该触发一次 95s 的历史抓取。需要补跑时显式打开。
   */
  catchUpOnStart: boolean
  /** 运行日志文件（留空则不落盘） */
  logFile: string
  /** 当日运行状态文件（幂等判据；留空则用 <dshHome>/super-injector/） */
  stateFile: string
  /** dispose 时等待在途任务的上限（ms），超时记录错误但不阻塞卸载 */
  cleanupTimeoutMs: number
  /** 是否开启盘中实时刷新 */
  rtEnabled: boolean
  /** 盘中刷新间隔（秒）。实测新浪源约 500ms 一拍，间隔 <1s 无意义 */
  rtIntervalSec: number
  /** 盘中实时榜的文件名（不含扩展名） */
  rtName: string
  /**
   * 是否由本插件承担**每日日报**的定时任务。
   *
   * 默认 true（插件单独可用）。但本部署里日报已移交**独立调度器**
   * `standalone/scheduler.mjs`（脱离 DSH 运行），因此随源码发布的
   * `cordis.patch.yml` 里显式关掉 —— 否则两个组件会在同一时刻（09:00:00）
   * 各自完整抓一遍六所 32 天数据，并在同一批文件上并发写盘。
   */
  dailyEnabled: boolean
}

export const Config: z<Config> = z.object({
  hour: z.number().min(0).max(23).default(9),
  minute: z.number().min(0).max(59).default(0),
  outDir: z.string().default(''),
  lookbackDays: z.number().min(26).max(60).default(32),
  runOnStart: z.boolean().default(true),
  catchUpOnStart: z.boolean().default(false),
  logFile: z.string().default(''),
  stateFile: z.string().default(''),
  cleanupTimeoutMs: z.number().min(500).max(60000).default(5000),
  // 盘中实时默认关闭：实时轮询已移交独立服务 realtime-server，
  // 两处同时打数据源会违反 docs/10 §4.3 的请求速率闸门。需要时在 cordis.patch.yml 里显式打开。
  rtEnabled: z.boolean().default(false),
  rtIntervalSec: z.number().min(1).max(60).default(2),
  rtName: z.string().default('盘中实时'),
  // 每日日报默认开启（插件单独使用时自洽）；本部署由独立调度器负责，patch 里关掉。
  dailyEnabled: z.boolean().default(true),
})


/**\n * workspace 根目录：优先环境变量，其次由插件自身位置推断
 * （插件位于 <workspace>/rank20-daemon/lib/index.js，上溯两级即 workspace）。
 * 这样无论宿主进程 cwd 是什么，输出都稳定落在本工作区。
 */
function resolveWorkspace(): string {
  const fromEnv = process.env.DSH_WORKSPACE ?? process.env.DSH_CWD
  if (fromEnv && fromEnv.length > 0) return fromEnv
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  } catch {
    return process.cwd()
  }
}

/**
 * 独立实时服务是否在运行：读它写在共享数据目录里的心跳。
 * 新鲜度阈值 60s（服务节拍 1.5s，60s 已是极宽松的存活判据）。
 */
const RT_LOCK_FRESH_MS = 60_000
function realtimeServerActive(dir: string): boolean {
  try {
    const doc = JSON.parse(readFileSync(join(dir, '.realtime-server.heartbeat'), 'utf8')) as { ts?: number }
    return Date.now() - Number(doc.ts ?? 0) < RT_LOCK_FRESH_MS
  } catch {
    return false
  }
}

/** 当日运行状态（幂等判据，跨进程/跨代持久） */
interface RunState {
  lastSuccessAt?: string
  lastSuccessDay?: string
  lastTradeDate?: string
}

export function apply(ctx: Context, config: Config): void {
  const SHORT = 'dsh-rank20-daemon'
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = join(dshHome, 'super-injector')
  const logFile = config.logFile || join(stateDir, `${SHORT}.log`)
  const stateFile = config.stateFile || join(stateDir, `${SHORT}.state.json`)
  const workspace = resolveWorkspace()
  const outDir = config.outDir || join(workspace, 'rank20')

  // ── 本代实例的生命周期状态（每代一份，绝不跨代共享）──────────────────
  const ac = new AbortController()
  const signal = ac.signal
  let disposed = false
  let stopping = false
  const inFlight = new Set<Promise<unknown>>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let running = false
  let rtRunning = false
  let cycles = 0
  let rtWrites = 0
  let rtDeferredLogged = false
  let lastResult: Rank20Result | null = null
  let baseRows: RankRow[] | null = null
  let baseMap: SettleMap | null = null
  let baseTradeDate = ''

  /** 是否已进入"不再产生副作用"的状态 */
  const dead = (): boolean => disposed || stopping || signal.aborted

  const log = (msg: string): void => {
    const line = `[${new Date().toISOString()}] ${msg}`
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, line + '\n')
    } catch {
      /* 日志失败静默 */
    }
    ctx.logger?.info?.(`[${SHORT}] ${msg}`)
  }

  /** 登记异步任务：保证 dispose 时能等到它，而不是散落的 void Promise */
  function track<T>(p: Promise<T>): Promise<T> {
    inFlight.add(p as Promise<unknown>)
    const done = (): void => {
      inFlight.delete(p as Promise<unknown>)
    }
    void p.then(done, done)
    return p
  }

  /** 受本代管理的定时器（原生实现，不依赖 timer 服务） */
  function later(cb: () => void, delayMs: number): void {
    if (dead()) return
    const t = setTimeout(() => {
      timers.delete(t)
      if (dead()) return
      cb()
    }, Math.max(0, delayMs))
    timers.add(t)
  }

  function clearTimers(): void {
    for (const t of timers) clearTimeout(t)
    timers.clear()
  }

  // ── 运行状态持久化（幂等判据）────────────────────────────────────────
  function readState(): RunState {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8')) as RunState
    } catch {
      return {}
    }
  }
  function writeState(s: RunState): void {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }
  /** 当天是否已经成功完成过一次（状态文件 或 当日 base.json 双重判据） */
  function completedToday(): { done: boolean; how: string } {
    const today = localDay()
    const st = readState()
    if (st.lastSuccessDay === today) return { done: true, how: `状态文件 lastSuccessAt=${st.lastSuccessAt}` }
    try {
      const doc = JSON.parse(readFileSync(join(outDir, 'base.json'), 'utf8')) as { generatedAt?: string }
      if (doc.generatedAt && localDay(new Date(doc.generatedAt)) === today) {
        return { done: true, how: `当日 base.json generatedAt=${doc.generatedAt}` }
      }
    } catch {
      /* 无 base.json */
    }
    return { done: false, how: '' }
  }

  /** 计算下一个目标时刻到现在的毫秒数 */
  function msUntilNext(hour: number, minute: number): number {
    const now = new Date()
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    return next.getTime() - now.getTime()
  }

  /** 当日是否已过目标时刻 */
  function pastToday(hour: number, minute: number): boolean {
    const now = new Date()
    const target = new Date(now)
    target.setHours(hour, minute, 0, 0)
    return now.getTime() >= target.getTime()
  }

  /**
   * 执行一次完整任务。
   * 取消（dispose）导致的退出走 CancelledError 分支，**不记为业务失败**。
   */
  async function runOnce(reason: string): Promise<void> {
    if (running) {
      log(`跳过（上一轮仍在运行）reason=${reason}`)
      return
    }
    if (dead()) return
    running = true
    cycles += 1
    const gen = cycles
    const t0 = Date.now()
    log(`▶ 第 ${gen} 轮开始 reason=${reason} lookback=${config.lookbackDays} 工作日`)
    try {
      const map = await fetchAllExchanges(config.lookbackDays, log, signal)
      if (dead()) {
        log(`■ 第 ${gen} 轮因卸载中止（历史抓取阶段，未写任何文件）`)
        return
      }
      const result = computeRank20(map)
      if (dead()) {
        log(`■ 第 ${gen} 轮因卸载中止（计算完成但已卸载，未写任何文件）`)
        return
      }
      lastResult = result

      if (result.all.length === 0) {
        log(`✗ 无有效数据，未写出。诊断：${result.diagnostics.join('; ')}`)
        return
      }

      const dir = outDir
      mkdirSync(dir, { recursive: true })
      const md = renderMarkdown(result)
      const csv = renderCsv(result)

      // 取消检查放在**每一次写盘之前**：dispose 后绝不再落文件
      if (dead()) return
      const stamp = stampName()
      writeFileSync(join(dir, `${stamp}.md`), md, 'utf8')
      writeFileSync(join(dir, `${stamp}.csv`), csv, 'utf8')
      writeFileSync(join(dir, 'latest.md'), md, 'utf8')

      const baseJson = buildBaseTable(result, map)
      writeFileSync(join(dir, 'base.json'), baseJson, 'utf8')
      writeFileSync(join(dir, `base-${result.tradeDate}.json`), baseJson, 'utf8')

      if (dead()) return

      // ── 日K线（D3）：官方日报窗口优先，新浪补更早的历史 ────────────────
      // 失败不阻塞日报（日报是 D1/D2 的交付载体）；失败原因如实记录。
      try {
        const ks = await refreshKline(
          dir,
          result.all.map((r) => ({ variety: r.variety, name: r.name, contract: r.contract })),
          map,
          { log, signal, symbolOf: (c) => sinaKlineCode(c) },
        )
        log(
          `📈 日K线已刷新：${ks.contracts} 个合约 / ${ks.bars} 根` +
            (ks.officialOnly ? `（${ks.officialOnly} 个仅有官方窗口）` : '') +
            (ks.failed.length ? `（历史不可用 ${ks.failed.length} 个）` : ''),
        )
      } catch (e) {
        if (isCancelled(e)) {
          log(`■ 第 ${gen} 轮因卸载中止（日K线阶段）`)
          return
        }
        log(`⚠️ 日K线刷新失败（日报不受影响）：${e instanceof Error ? e.message : String(e)}`)
      }

      if (dead()) return
      // 缓存基准，供盘中实时刷新使用（仅在本代仍存活时）
      baseRows = result.all
      baseMap = map
      baseTradeDate = result.tradeDate
      writeState({
        lastSuccessAt: new Date().toISOString(),
        lastSuccessDay: localDay(),
        lastTradeDate: result.tradeDate,
      })

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      const top = result.gainers[0]
      const bottom = result.losers[0]
      log(
        `✓ 第 ${gen} 轮完成 (${elapsed}s) 交易日=${result.tradeDate} 基准日=${result.baseDate} ` +
          `品种=${result.all.length} 涨幅榜首=${top?.name ?? '-'} ${top?.pct.toFixed(2) ?? '-'}% ` +
          `跌幅榜首=${bottom?.name ?? '-'} ${bottom?.pct.toFixed(2) ?? '-'}% → ${join(dir, `${stamp}.md`)}`,
      )
      for (const d of result.diagnostics) log(`  · ${d}`)
    } catch (e) {
      if (isCancelled(e)) {
        log(`■ 第 ${gen} 轮因卸载中止（请求已 abort，未写任何文件）`)
        return
      }
      log(`✗ 第 ${gen} 轮失败：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
    } finally {
      running = false
    }
  }

  /**
   * 盘中实时刷新一轮。
   *
   * 只换分子：基准日结算价（分母）来自当日官方日报，盘中不变；
   * 用新浪实时最新价替换「今收盘」重算 20 日涨跌幅 → 重新排名 → 覆盖实时榜文件。
   * 取不到实时价的合约（月均价 F、临时停牌）保留日报口径的值，保证榜单仍完整。
   */
  async function runRealtime(): Promise<void> {
    if (rtRunning || dead() || !baseRows || baseRows.length === 0 || !baseMap) return

    // 协作锁：独立服务 realtime-server 在跑时本进程让位，避免两处同时打数据源
    // （docs/10 §4.3 的请求速率闸门是按"整个项目"计的）。
    if (realtimeServerActive(outDir)) {
      if (!rtDeferredLogged) {
        log('检测到 realtime-server 心跳，本进程暂停盘中实时刷新（由该服务统一轮询）')
        rtDeferredLogged = true
      }
      return
    }
    rtDeferredLogged = false

    rtRunning = true
    try {
      const quotes = await fetchLiveQuotes(baseRows.map((r) => r.contract), { signal })
      if (dead()) return

      if (quotes.size === 0) return

      // 行情带回了「今天」的交易日标注。若已越过上次计算所用交易日，
      // 说明进入新交易日，T 与 T−20 都要前移，必须用虚拟今日重算基准。
      const liveT = [...quotes.values()]
        .map((q) => q.tradeDay.replace(/-/g, ''))
        .filter((s) => /^\d{8}$/.test(s))
        .sort()
        .pop()
      if (liveT && liveT !== baseTradeDate && !dead()) {
        const fresh = computeRank20(baseMap, liveT)
        if (fresh.all.length > 0) {
          baseRows = fresh.all
          lastResult = fresh
          baseTradeDate = fresh.tradeDate
          log(`↻ 交易日推进到 ${fresh.tradeDate}，基准日前移至 ${fresh.baseDate}`)
        }
      }

      let live = 0
      const rows: RankRow[] = baseRows.map((r) => {
        const q = quotes.get(r.contract.toUpperCase())
        if (!q) return r
        live++
        return { ...r, close: q.price, pct: ((q.price - r.baseSettle) / r.baseSettle) * 100 }
      })
      rows.sort((a, b) => b.pct - a.pct)

      const src = [...quotes.values()].find((q) => q.time)
      const stamp = src?.time
        ? `${src.time.slice(0, 2)}:${src.time.slice(2, 4)}:${src.time.slice(4, 6)}`
        : new Date().toLocaleTimeString('zh-CN')
      const result: Rank20Result = {
        tradeDate: baseTradeDate,
        baseDate: lastResult?.baseDate ?? '',
        runAt: new Date().toISOString(),
        gainers: rows.slice(0, 20),
        losers: rows.slice(-20).reverse(),
        all: rows,
        diagnostics: [],
        note: `**盘中实时** · 行情时间 ${stamp} · 已换价 ${live}/${baseRows.length} 个合约（月均价合约无实时价，沿用日报）`,
      }

      // 写盘前最后一道取消检查
      if (dead()) return
      const dir = outDir
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${config.rtName}.md`), renderMarkdown(result), 'utf8')
      writeFileSync(join(dir, `${config.rtName}.csv`), renderCsv(result), 'utf8')
      rtWrites++
      if (rtWrites === 1 || rtWrites % 30 === 0) {
        log(
          `↻ 盘中实时第 ${rtWrites} 次刷新（行情时间 ${stamp}，换价 ${live}/${baseRows.length}）` +
            ` 涨幅榜首=${result.gainers[0]?.name} ${result.gainers[0]?.pct.toFixed(2)}%`,
        )
      }
    } catch (e) {
      if (isCancelled(e)) return // 卸载取消：静默
      log(`↻ 盘中刷新失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      rtRunning = false
    }
  }

  // ── 调度 ─────────────────────────────────────────────────────────────
  /** 注册（可重置的）每日定时器 */
  function armDaily(): void {
    // 注意用 `=== false` 而不是真值判断：宿主会按 schema 填默认值，
    // 但测试/裸调用可能不传该键 —— undefined 必须等价于"默认开启"。
    if (config.dailyEnabled === false || dead()) return
    clearTimers()
    const delay = msUntilNext(config.hour, config.minute)
    const target = new Date(Date.now() + delay)
    log(`⏰ 下次运行：${target.toLocaleString('zh-CN')}（${(delay / 3600000).toFixed(2)} 小时后）`)
    later(() => {
      track(runOnce('scheduled')).finally(() => armDaily())
    }, delay)
  }

  /** 盘中实时刷新调度：交易时段内按 rtIntervalSec 跑，非交易时段 60s 醒一次 */
  function armRealtime(): void {
    if (!config.rtEnabled || dead()) return
    const active = inTradingWindow()
    const delay = active ? config.rtIntervalSec * 1000 : 60000
    later(() => {
      track(runRealtime()).finally(() => armRealtime())
    }, delay)
  }

  // ── 卸载清理（本插件生命周期问题的核心修复）──────────────────────────
  const registerCleanup = (): void => {
    const ectx = ctx as EffectContext
    const cleanup = async (): Promise<void> => {
      stopping = true
      disposed = true
      ac.abort() // 1) 先停：所有在途 fetch / 重试等待 / 限流等待立即中断
      clearTimers() // 2) 定时器全清，绝不再 arm

      const pending = [...inFlight]
      if (pending.length === 0) {
        log('✓ 卸载完成：无在途任务，取消信号已发出')
        return
      }
      log(`⏳ 卸载中：已 abort，等待 ${pending.length} 个在途任务（上限 ${config.cleanupTimeoutMs}ms）`)
      const t0 = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), config.cleanupTimeoutMs)
      })
      const settled = Promise.allSettled(pending).then(() => 'settled' as const)
      const outcome = await Promise.race([settled, timeout])
      if (timer) clearTimeout(timer)
      if (outcome === 'timeout') {
        log(
          `✗ 卸载超时（${config.cleanupTimeoutMs}ms）：仍有 ${inFlight.size} 个在途任务未结束；` +
            `已 abort 且不再持有副作用，fiber 卸载继续（不阻塞热重载）`,
        )
      } else {
        log(`✓ 卸载完成：在途任务已全部结束（${Date.now() - t0}ms），未写任何文件`)
      }
    }
    if (typeof ectx.effect === 'function') {
      ectx.effect(() => cleanup)
    } else {
      // 宿主未提供 ctx.effect（极简测试上下文）：退化为进程级兜底
      process.once('SIGTERM', () => void cleanup())
      process.once('SIGINT', () => void cleanup())
    }
  }

  registerCleanup()

  // ── 启动 ─────────────────────────────────────────────────────────────
  armDaily()
  armRealtime()

  if (config.dailyEnabled === false) {
    log('⏸ 每日日报已关闭（dailyEnabled=false）—— 由独立调度器 standalone/scheduler.mjs 负责，本插件不再定时抓取')
  } else if (config.runOnStart) {
    const { done, how } = completedToday()
    if (done) {
      log(`⏭ 启动检查：今日已完成过一次（${how}），跳过补跑，不重复抓取`)
    } else if (!config.catchUpOnStart) {
      log(
        `⏭ 启动检查：今日尚未运行，但 catchUpOnStart=false —— 等待 ${config.hour}:` +
          `${String(config.minute).padStart(2, '0')} 的正常调度（热重载不触发抓取）`,
      )
    } else {
      log(`⚡ 今日 ${config.hour}:${String(config.minute).padStart(2, '0')} 已过，启动补跑一次`)
      track(runOnce(pastToday(config.hour, config.minute) ? 'catch-up-on-start' : 'startup-check'))
    }
  }

  ctx.logger?.info?.(
    (config.dailyEnabled === false
      ? `[${SHORT}] 已启动：每日日报已关闭（由独立调度器负责）`
      : `[${SHORT}] 已启动：每日 ${config.hour}:${String(config.minute).padStart(2, '0')} 出日报` +
        (config.catchUpOnStart ? '（允许启动补跑）' : '（不补跑）')) +
      (config.rtEnabled ? `，盘中每 ${config.rtIntervalSec}s 刷新 ${config.rtName}.md` : '') +
      `，输出至 ${outDir}`,
  )
}

/** 供测试引用：判断输出目录里是否已有当日 base.json（不导出则测试需自行实现） */
export function baseJsonExists(outDir: string, day = localDay()): boolean {
  try {
    const doc = JSON.parse(readFileSync(join(outDir, 'base.json'), 'utf8')) as { generatedAt?: string }
    return !!doc.generatedAt && localDay(new Date(doc.generatedAt)) === day
  } catch {
    return false
  }
}
