/**
 * 一键跑完全部验收套件（CI / 上机自检用）
 *
 *   node tools/run-tests.mjs            # 全量（含需要真实行情/网络的套件）
 *   node tools/run-tests.mjs --fast     # 跳过耗时的真实抓取与网络探测
 *   node tools/run-tests.mjs --list     # 只列清单
 *
 * 设计：
 *   · 逐个子进程跑（互相隔离端口/临时目录），失败不中断，最后汇总
 *   · 需要 rank20/ 数据的套件在数据缺失时打印 SKIP（clone 下来第一次跑会命中）
 *   · 退出码：有失败 → 1
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FAST = process.argv.includes('--fast')
const LIST = process.argv.includes('--list')

/** { name, cwd, args, tags } —— tags 里的 network/data 表示"依赖真实抓取或已有数据" */
const SUITES = [
  { name: '独立性（不依赖任何 DSH 插件）', cwd: 'standalone', args: ['test/verify-independence.mjs'] },
  { name: '凭据 / 环境变量（安全红线）', cwd: 'rank20-daemon', args: ['test/env.test.mjs'] },
  { name: '生命周期 / 幂等 / dailyEnabled', cwd: 'rank20-daemon', args: ['test/lifecycle.test.mjs'] },
  { name: '发布前审计（密钥/路径/产物/体积）', cwd: '.', args: ['tools/audit-publish.mjs'] },
  { name: '前端静态自检（DOM/class/死变量）', cwd: 'realtime-server', args: ['test/audit-frontend.mjs'] },
  { name: '布局验收（双榜一屏、零滚动条）', cwd: 'realtime-server', args: ['test/verify-layout.mjs'] },
  { name: '模型 Key 安全 + 源探测（桩外部 HTTP）', cwd: 'realtime-server', args: ['test/verify-ops.mjs'] },
  { name: '前端渲染（最小 DOM 桩真跑 app.js）', cwd: 'realtime-server', args: ['test/verify-ops-ui.mjs'] },
  { name: '实时链路诊断（桩外部 HTTP + 平移时钟）', cwd: 'realtime-server', args: ['test/diag-realtime.mjs'] },
  { name: 'K线 / 硬逻辑端到端', cwd: 'realtime-server', args: ['test/verify-kline.mjs'], tags: 'data' },
  { name: '实时服务验收（真打数据源）', cwd: 'realtime-server', args: ['test/verify.mjs'], tags: 'network' },
  { name: '独立运行全栈', cwd: 'standalone', args: ['test/verify-standalone.mjs', '--skip-daily'], tags: 'data' },
  { name: '口径命中（与已对账值逐条比对）', cwd: 'rank20-daemon', args: ['test-run.mjs', '32', '20260916'], tags: 'network' },
]

if (LIST) {
  for (const s of SUITES) console.log(`${s.tags ? `[${s.tags}] ` : '        '}${s.name}  →  node ${s.args.join(' ')}`)
  process.exit(0)
}

const hasData = existsSync(join(ROOT, 'rank20', 'base.json'))
console.log(`\n═══ 全部验收套件 ${FAST ? '（--fast：跳过依赖真实数据的套件）' : ''} ═══`)
if (!hasData) console.log('提示：尚未生成 rank20/base.json —— 依赖数据的套件会打印 SKIP\n先跑一次 `npm run daily`（或 `node standalone/daily-job.mjs`）即可。\n')

const results = []
for (const s of SUITES) {
  const skip = FAST && s.tags
  const line = s.name.padEnd(38)
  if (skip) {
    console.log(`  SKIP  ${line} (--fast)`)
    results.push({ ...s, status: 'skip' })
    continue
  }
  const t0 = Date.now()
  const r = spawnSync(process.execPath, s.args, { cwd: join(ROOT, s.cwd), stdio: 'pipe', encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const tally = (out.match(/结果：\s*\d+\/\d+ 通过|全部通过 ✓|命中 \d+\/\d+|\d+\/\d+ 通过/g) ?? []).at(-1) ?? ''
  const skipped = /SKIP|跳过/.test(out) && r.status === 0
  // 命中率型套件（口径回归）额外校验：命中数必须等于总数，否则即使进程退出码为 0 也算失败
  const hits = /命中\s*(\d+)\/(\d+)/.exec(out)
  const hitFail = hits && Number(hits[1]) !== Number(hits[2])
  if (r.status === 0 && !hitFail) {
    console.log(`  PASS  ${line} ${tally.padEnd(22)} ${secs}s${skipped ? '  (含 SKIP)' : ''}`)
    results.push({ ...s, status: 'pass', tally, out })
  } else {
    console.log(`  FAIL  ${line} ${tally.padEnd(22)} ${secs}s${hitFail ? '  (命中不足)' : ''}`)
    results.push({ ...s, status: 'fail', tally, out })
  }
}

const fails = results.filter((r) => r.status === 'fail')
if (fails.length) {
  console.log('\n──── 失败详情 ────')
  for (const f of fails) {
    const lines = (f.out ?? '').split('\n').filter((l) => /✗|Error|error:|失败/.test(l)).slice(0, 8)
    console.log(`  ▸ ${f.name}`)
    for (const l of lines) console.log(`      ${l.trim()}`)
  }
}

const pass = results.filter((r) => r.status === 'pass').length
const skip = results.filter((r) => r.status === 'skip').length
console.log(`\n═══ 汇总：${pass} 通过 / ${fails.length} 失败 / ${skip} 跳过（共 ${results.length} 套）═══\n`)
process.exit(fails.length ? 1 : 0)
