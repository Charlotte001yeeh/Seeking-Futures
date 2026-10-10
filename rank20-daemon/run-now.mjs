/**
 * 手动立即跑一次（与每日 09:00 定时任务完全相同的流程与输出）。
 *
 * 用法：
 *   node run-now.mjs            # 采集 32 个工作日
 *   node run-now.mjs 40         # 自定义采集天数（≥26）
 *
 * 输出：<workspace>/rank20/YYYY年MM月DD日HH时.md / .csv
 */
import { fetchAllExchanges } from './dist/exchanges.js'
import { computeRank20, renderCsv, renderMarkdown } from './dist/rank20.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = join(here, '..')            // <workspace>/rank20-daemon → <workspace>
const outDir = join(workspace, 'rank20')
const days = Number(process.argv[2] ?? 32)

const log = (m) => console.log(m)

console.log(`=== 抓取最近 ${days} 个工作日 ===`)
const t0 = Date.now()
const map = await fetchAllExchanges(days, log)
console.log(`抓取完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const result = computeRank20(map)
console.log(`\n交易日=${result.tradeDate} 基准日=${result.baseDate} 品种数=${result.all.length}`)
for (const d of result.diagnostics) console.log(`  诊断: ${d}`)

if (result.all.length === 0) {
  console.error('✗ 无有效数据，未写出')
  process.exit(1)
}

const p = (n) => String(n).padStart(2, '0')
const now = new Date()
const stamp = `${now.getFullYear()}年${p(now.getMonth() + 1)}月${p(now.getDate())}日${p(now.getHours())}时`

mkdirSync(outDir, { recursive: true })
const md = renderMarkdown(result)
writeFileSync(join(outDir, `${stamp}.md`), md, 'utf8')
writeFileSync(join(outDir, `${stamp}.csv`), renderCsv(result), 'utf8')
writeFileSync(join(outDir, 'latest.md'), md, 'utf8')

const top = result.gainers[0]
const bottom = result.losers[0]
console.log(
  `\n✓ 完成 涨幅榜首=${top?.name} ${top?.pct.toFixed(2)}%  跌幅榜首=${bottom?.name} ${bottom?.pct.toFixed(2)}%`,
)
console.log(`→ ${join(outDir, `${stamp}.md`)}`)
