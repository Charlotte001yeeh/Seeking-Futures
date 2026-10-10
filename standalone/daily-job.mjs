#!/usr/bin/env node
/**
 * 独立每日任务（**不依赖 DSH**）
 *
 * 职责：抓六所官方日报 → 算 20 日涨跌幅 rank20 → 写
 *   <outDir>/YYYY年MM月DD日HH时.md / .csv     人看的双榜
 *   <outDir>/latest.md                        固定入口
 *   <outDir>/base.json                        实时服务的唯一输入（基准表）
 *   <outDir>/base-<交易日>.json               按交易日留档
 *
 * 与 DSH 插件版的关系：
 *   两者产出**同一套文件、同一份 base.json 契约**，并且都按「当日 base.json 是否已存在」
 *   做幂等判断 —— 所以同时装着也不会重复抓取（先跑的那个当天完成，后跑的直接跳过）。
 *   本脚本只依赖 node 标准库 + rank20-daemon/dist 下**零三方依赖**的算法模块。
 *
 * 用法：
 *   node standalone/daily-job.mjs                    # 幂等跑一次
 *   node standalone/daily-job.mjs --force            # 强制重跑
 *   node standalone/daily-job.mjs --out <dir>        # 指定输出目录
 *   node standalone/daily-job.mjs --lookback 32      # 采集天数（≥26 才能覆盖 T−20）
 */
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { fetchAllExchanges } from '../rank20-daemon/dist/exchanges.js'
import { computeRank20, renderCsv, renderMarkdown } from '../rank20-daemon/dist/rank20.js'
import { buildBaseTable } from '../rank20-daemon/dist/basetable.js'
import { stampName, localDay } from '../rank20-daemon/dist/naming.js'
import { refreshKline, sinaKlineCode } from '../rank20-daemon/dist/kline.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** standalone/ 的上级 = 工作区根 */
export const WORKSPACE = resolve(HERE, '..')
export const DEFAULT_OUT_DIR = join(WORKSPACE, 'rank20')
export const DEFAULT_VAR_DIR = join(HERE, 'var')

/** 当日 base.json 是否已产出（幂等判据，与 DSH 插件版一致） */
export function completedToday(outDir, day = localDay()) {
  const p = join(outDir, 'base.json')
  if (!existsSync(p)) return { done: false }
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    if (!doc.generatedAt) return { done: false }
    const g = new Date(doc.generatedAt)
    const key = `${g.getFullYear()}-${String(g.getMonth() + 1).padStart(2, '0')}-${String(g.getDate()).padStart(2, '0')}`
    return key === day
      ? { done: true, reason: `当日 base.json 已存在（generatedAt=${doc.generatedAt}，交易日 ${doc.tradeDate}）` }
      : { done: false }
  } catch {
    return { done: false }
  }
}

/**
 * 跑一次每日任务。
 * @param {object} opts
 * @param {string} [opts.outDir]  输出目录（默认 <workspace>/rank20）
 * @param {string} [opts.varDir]  本脚本自己的目录（日志/状态）
 * @param {number} [opts.lookbackDays]
 * @param {boolean} [opts.force]  忽略幂等检查
 * @param {(m:string)=>void} [opts.log]
 * @param {AbortSignal} [opts.signal]
 */
export async function runDailyJob(opts = {}) {
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR
  const varDir = opts.varDir ?? DEFAULT_VAR_DIR
  const lookbackDays = Number(opts.lookbackDays ?? 32)
  const force = !!opts.force
  const signal = opts.signal

  const logFile = join(varDir, 'daily-job.log')
  const log = (m) => {
    const line = `[${new Date().toISOString()}] ${m}`
    try {
      mkdirSync(varDir, { recursive: true })
      appendFileSync(logFile, line + '\n')
    } catch {
      /* ignore */
    }
    if (opts.log !== null) ;(opts.log ?? console.log)(m)
  }

  if (!force) {
    const done = completedToday(outDir)
    if (done.done) {
      log(`⏭ 今日已完成，跳过抓取 —— ${done.reason}`)
      return { skipped: true, reason: done.reason }
    }
  }

  const t0 = Date.now()
  log(`▶ 独立每日任务开始 lookback=${lookbackDays} 输出=${outDir}`)
  const map = await fetchAllExchanges(lookbackDays, log, signal)
  const result = computeRank20(map)

  if (result.all.length === 0) {
    const msg = `✗ 无有效数据，未写出。诊断：${result.diagnostics.join('; ')}`
    log(msg)
    throw new Error(msg)
  }

  mkdirSync(outDir, { recursive: true })
  const md = renderMarkdown(result)
  const csv = renderCsv(result)
  const stamp = stampName()
  writeFileSync(join(outDir, `${stamp}.md`), md, 'utf8')
  writeFileSync(join(outDir, `${stamp}.csv`), csv, 'utf8')
  writeFileSync(join(outDir, 'latest.md'), md, 'utf8')

  const baseJson = buildBaseTable(result, map, 'standalone-daily-job')
  writeFileSync(join(outDir, 'base.json'), baseJson, 'utf8')
  writeFileSync(join(outDir, `base-${result.tradeDate}.json`), baseJson, 'utf8')

  // ── 日K线（D3）：官方日报窗口优先，新浪补更早历史；失败不阻塞日报 ──────
  try {
    const ks = await refreshKline(
      outDir,
      result.all.map((r) => ({ variety: r.variety, name: r.name, contract: r.contract })),
      map,
      { log, signal, symbolOf: (c) => sinaKlineCode(c) },
    )
    log(
      `📈 日K线已刷新：${ks.contracts} 个合约 / ${ks.bars} 根` +
        (ks.officialOnly ? `（${ks.officialOnly} 个仅有官方窗口）` : '') +
        (ks.failed.length ? `（历史不可用 ${ks.failed.length} 个：${ks.failed.join(',')}）` : ''),
    )
  } catch (e) {
    log(`⚠️ 日K线刷新失败（日报不受影响）：${e instanceof Error ? e.message : String(e)}`)
  }

  // 运行状态（与 DSH 插件版共用同一份语义）
  try {
    mkdirSync(varDir, { recursive: true })
    writeFileSync(
      join(varDir, 'daily-job.state.json'),
      JSON.stringify(
        { lastSuccessAt: new Date().toISOString(), lastSuccessDay: localDay(), lastTradeDate: result.tradeDate },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    /* ignore */
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  log(
    `✓ 完成 (${elapsed}s) 交易日=${result.tradeDate} 基准日=${result.baseDate} 品种=${result.all.length} ` +
      `涨幅榜首=${result.gainers[0]?.name} ${result.gainers[0]?.pct.toFixed(2)}% ` +
      `跌幅榜首=${result.losers[0]?.name} ${result.losers[0]?.pct.toFixed(2)}%`,
  )
  for (const d of result.diagnostics) log(`  · ${d}`)

  return { skipped: false, elapsedMs: Date.now() - t0, result, basePath: join(outDir, 'base.json') }
}

// ── CLI ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const get = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
  }
  return {
    outDir: get('out', DEFAULT_OUT_DIR),
    varDir: get('var', DEFAULT_VAR_DIR),
    lookbackDays: Number(get('lookback', 32)),
    force: argv.includes('--force'),
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const ac = new AbortController()
  process.on('SIGINT', () => ac.abort())
  process.on('SIGTERM', () => ac.abort())
  runDailyJob({ ...parseArgs(process.argv.slice(2)), signal: ac.signal })
    .then((r) => process.exit(r.skipped ? 0 : 0))
    .catch((e) => {
      console.error(`[daily-job] 失败：${e?.stack ?? e}`)
      process.exit(1)
    })
}
