#!/usr/bin/env node
/**
 * 常驻调度器（**不依赖 DSH**）
 *
 * 每天本地 09:00 跑一次独立每日任务；启动时做一次幂等检查
 * （当日 base.json 已存在则跳过，所以重启/重跑不会重复抓取）。
 *
 * 用法：
 *   node standalone/scheduler.mjs                       # 常驻，每日 09:00
 *   node standalone/scheduler.mjs --hour 9 --minute 0
 *   node standalone/scheduler.mjs --once                # 只做一次幂等检查+按需补跑后退出
 *   node standalone/scheduler.mjs --no-catchup          # 启动时不补跑，只等定时
 */
import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runDailyJob, DEFAULT_OUT_DIR, DEFAULT_VAR_DIR, WORKSPACE } from './daily-job.mjs'

/**
 * @param {object} opts
 * @param {number} [opts.hour]
 * @param {number} [opts.minute]
 * @param {string} [opts.outDir]
 * @param {string} [opts.varDir]
 * @param {number} [opts.lookbackDays]
 * @param {boolean} [opts.catchUpOnStart] 启动时若当日尚未完成是否立即补跑（默认 true）
 * @param {(m:string)=>void} [opts.log]
 * @returns {{ stop: () => void, next: () => Date | null }}
 */
export function startScheduler(opts = {}) {
  const hour = Number(opts.hour ?? 9)
  const minute = Number(opts.minute ?? 0)
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR
  const varDir = opts.varDir ?? DEFAULT_VAR_DIR
  const lookbackDays = Number(opts.lookbackDays ?? 32)
  const catchUpOnStart = opts.catchUpOnStart !== false

  const logFile = join(varDir, 'scheduler.log')
  const log = (m) => {
    const line = `[${new Date().toISOString()}] ${m}`
    try {
      mkdirSync(varDir, { recursive: true })
      appendFileSync(logFile, line + '\n')
    } catch {
      /* ignore */
    }
    ;(opts.log ?? console.log)(m)
  }

  const ac = new AbortController()
  let timer = null
  let stopped = false
  let running = false
  let nextAt = null

  function msUntilNext() {
    const now = new Date()
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    nextAt = next
    return next.getTime() - now.getTime()
  }

  async function tick(reason) {
    if (stopped || running) return
    running = true
    try {
      await runDailyJob({ outDir, varDir, lookbackDays, log, signal: ac.signal })
    } catch (e) {
      log(`✗ 第 ${reason} 轮失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      running = false
    }
  }

  function arm() {
    if (stopped) return
    const delay = msUntilNext()
    log(`⏰ 下次运行：${nextAt.toLocaleString('zh-CN')}（${(delay / 3600000).toFixed(2)} 小时后）`)
    timer = setTimeout(() => {
      timer = null
      void tick('scheduled').finally(() => arm())
    }, delay)
  }

  log(`=== 独立调度器启动（${hour}:${String(minute).padStart(2, '0')} 每日）===`)
  log(`  工作区：${WORKSPACE}`)
  log(`  输出：${outDir}`)
  arm()
  if (catchUpOnStart) void tick('startup')

  return {
    stop() {
      stopped = true
      ac.abort()
      if (timer) clearTimeout(timer)
    },
    next: () => nextAt,
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const get = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
  }
  return {
    hour: Number(get('hour', 9)),
    minute: Number(get('minute', 0)),
    outDir: get('out', DEFAULT_OUT_DIR),
    varDir: get('var', DEFAULT_VAR_DIR),
    lookbackDays: Number(get('lookback', 32)),
    once: argv.includes('--once'),
    catchUpOnStart: !argv.includes('--no-catchup'),
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (args.once) {
    runDailyJob({ ...args, log: console.log })
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(`[scheduler] 失败：${e?.stack ?? e}`)
        process.exit(1)
      })
  } else {
    const s = startScheduler(args)
    const bye = () => {
      console.log('\n[scheduler] 收到退出信号，停止中…')
      s.stop()
      setTimeout(() => process.exit(0), 200)
    }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
  }
}
