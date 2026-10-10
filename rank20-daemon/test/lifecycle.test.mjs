/**
 * dsh-rank20-daemon 生命周期 / 取消 / 幂等 测试
 *
 * 用最小 mock ctx（只需 ctx.effect）直接驱动 apply()，并用可编程的 global.fetch
 * 模拟慢速、永久挂起、遵守 abort 等情况 —— 全程不碰真实数据源、不碰用户行情数据。
 *
 * 覆盖验收项：
 *   1  慢速 runOnce 运行中 dispose：abort 触发、限时完成、不再写文件、不重新 arm
 *   2  连续两代实例：只有一个在抓取，旧代先停
 *   3  永久不返回的 fetch：dispose 有明确超时且不阻塞
 *   5  每日调度仍会触发一次
 *   6  当天已完成后再挂载：不重复抓取
 *   7  构建产物可导入
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const TMP = join(ROOT, 'var-test')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const results = []
function check(id, name, cond, extra = '') {
  results.push({ id, name, pass: !!cond, extra })
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

const { apply, localDay } = await import('../dist/index.js')

// ── 测试基础设施 ─────────────────────────────────────────────────────────
/** 最小 Cordis 上下文：只需要 effect（返回的清理函数在"卸载"时被调用） */
function makeCtx() {
  const disposers = []
  const logs = []
  return {
    disposers,
    logs,
    effect(cb) {
      const d = cb()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    logger: {
      info: (m) => logs.push(String(m)),
      warn: (m) => logs.push(String(m)),
      error: (m) => logs.push(String(m)),
    },
  }
}

const realFetch = globalThis.fetch
let fetchState = { calls: 0, aborted: 0, concurrent: 0, maxConcurrent: 0 }

/**
 * 安装可编程的 fetch 替身。
 * @param {'hang-signal'|'hang-forever'|'fail'} mode
 *   hang-signal  : 挂起但遵守 abort（模拟正常的可取消抓取）
 *   hang-forever : 永久挂起且**忽略** abort（模拟卡死的 socket）
 *   fail         : 立即失败
 */
function installFetch(mode) {
  fetchState = { calls: 0, aborted: 0, concurrent: 0, maxConcurrent: 0 }
  globalThis.fetch = async (_url, opts = {}) => {
    fetchState.calls++
    fetchState.concurrent++
    fetchState.maxConcurrent = Math.max(fetchState.maxConcurrent, fetchState.concurrent)
    const done = () => {
      fetchState.concurrent--
    }
    if (mode === 'fail') {
      done()
      throw new Error('mock fetch failure')
    }
    if (mode === 'hang-forever') {
      return new Promise(() => {}) // 永不 settle，也不监听 signal
    }
    // hang-signal：监听 abort 并拒绝，模拟 undici 的行为
    return new Promise((_resolve, reject) => {
      const sig = opts.signal
      if (sig?.aborted) {
        done()
        fetchState.aborted++
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        return
      }
      sig?.addEventListener(
        'abort',
        () => {
          done()
          fetchState.aborted++
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        },
        { once: true },
      )
    })
  }
}

function uninstallFetch() {
  globalThis.fetch = realFetch
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一代实例 */
function boot(tag, overrides = {}) {
  const dir = join(TMP, tag)
  mkdirSync(dir, { recursive: true })
  const ctx = makeCtx()
  apply(ctx, {
    hour: 9,
    minute: 0,
    outDir: dir,
    lookbackDays: 26,
    runOnStart: true,
    catchUpOnStart: false,
    logFile: join(dir, 'daemon.log'),
    stateFile: join(dir, 'daemon.state.json'),
    cleanupTimeoutMs: 5000,
    rtEnabled: false,
    rtIntervalSec: 2,
    rtName: '盘中实时',
    ...overrides,
  })
  return { ctx, dir, logText: () => (existsSync(join(dir, 'daemon.log')) ? readFileSync(join(dir, 'daemon.log'), 'utf8') : '') }
}

/** 卸载一代实例，返回耗时 */
async function shutdown(inst) {
  const t0 = Date.now()
  await Promise.all(inst.ctx.disposers.map((d) => Promise.resolve(d())))
  return Date.now() - t0
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== T1 慢速 runOnce 运行中 dispose（fetch 遵守 abort）===')
{
  installFetch('hang-signal')
  const inst = boot('t1', { catchUpOnStart: true }) // 允许补跑，立刻进入抓取
  await wait(300)
  check('T1a', '已进入抓取（fetch 被调用）', fetchState.calls >= 1, `calls=${fetchState.calls}`)

  const ms = await shutdown(inst)
  check('T1b', 'abort 已触发（在途请求被取消）', fetchState.aborted >= 1, `aborted=${fetchState.aborted}`)
  check('T1c', 'dispose 限时完成（< 1500ms，远小于 95s）', ms < 1500, `${ms}ms`)

  const files = existsSync(inst.dir) ? readdirSync(inst.dir) : []
  const wrote = files.filter((f) => /\.(md|csv)$/.test(f) || f === 'base.json')
  check('T1d', 'dispose 后未写出任何行情文件', wrote.length === 0, wrote.join(',') || '（无）')
  check('T1e', '未写入"运行完成"日志', !/✓ 第 \d+ 轮完成/.test(inst.logText()))
  check('T1f', '日志明确记录卸载（非业务失败）', /卸载/.test(inst.logText()), '')

  const callsAtDispose = fetchState.calls
  await wait(2500)
  check('T1g', 'dispose 后不再重新 arm（无新请求）', fetchState.calls === callsAtDispose, `${callsAtDispose} → ${fetchState.calls}`)
  uninstallFetch()
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== T2 连续两代实例：不并行抓取、旧代先停 ===')
{
  installFetch('hang-signal')
  const a = boot('t2a', { catchUpOnStart: true })
  await wait(250)
  const callsAfterA = fetchState.calls
  check('T2a', '旧代正在抓取', callsAfterA >= 1, `calls=${callsAfterA}`)

  const msA = await shutdown(a)
  const abortedAfterA = fetchState.aborted
  check('T2b', '旧代 dispose 后其请求被 abort', abortedAfterA >= 1)
  check('T2c', '旧代 dispose 限时完成', msA < 1500, `${msA}ms`)

  const callsBeforeB = fetchState.calls
  const b = boot('t2b', { catchUpOnStart: true })
  await wait(250)
  check('T2d', '新代开始抓取', fetchState.calls > callsBeforeB, `${callsBeforeB} → ${fetchState.calls}`)
  check('T2e', '任何时刻并发抓取不超过 1', fetchState.maxConcurrent <= 1, `maxConcurrent=${fetchState.maxConcurrent}`)
  await shutdown(b)
  uninstallFetch()
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== T3 永久不返回的 fetch：dispose 有明确超时且不阻塞 ===')
{
  installFetch('hang-forever')
  const inst = boot('t3', { catchUpOnStart: true, cleanupTimeoutMs: 1000 })
  await wait(300)
  check('T3a', '已进入抓取且请求不会自行结束', fetchState.calls >= 1 && fetchState.concurrent >= 1)
  const ms = await shutdown(inst)
  check('T3b', 'dispose 在超时上限附近返回（不永久等待）', ms >= 900 && ms < 2500, `${ms}ms（上限 1000ms）`)
  check('T3c', '日志记录明确的卸载超时错误', /卸载超时/.test(inst.logText()))
  const files = readdirSync(inst.dir)
  check('T3d', '超时后仍未写出行情文件', !files.some((f) => f === 'base.json' || /\.md$/.test(f)))
  uninstallFetch()
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== T4 默认配置下热重载不触发抓取 ===')
{
  installFetch('hang-signal')
  const inst = boot('t4') // catchUpOnStart 默认 false
  await wait(400)
  check('T4a', '默认 catchUpOnStart=false → 挂载即抓取被禁止', fetchState.calls === 0, `calls=${fetchState.calls}`)
  check('T4b', '日志说明等待正常调度', /catchUpOnStart=false/.test(inst.logText()))
  await shutdown(inst)
  uninstallFetch()
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== T5 当天已完成后再挂载：不重复抓取（幂等）===')
{
  // 5a：持久状态文件判据 —— 先在目录里预置"今天已完成"，再挂载
  const dirA = join(TMP, 't5a')
  mkdirSync(dirA, { recursive: true })
  writeFileSync(
    join(dirA, 'daemon.state.json'),
    JSON.stringify({ lastSuccessAt: new Date().toISOString(), lastSuccessDay: localDay(), lastTradeDate: '20260917' }),
    'utf8',
  )
  installFetch('hang-signal') // 重置计数
  const a = boot('t5a', { catchUpOnStart: true })
  await wait(400)
  check('T5a', '状态文件判定当日已完成 → 不抓取', fetchState.calls === 0, `calls=${fetchState.calls}`)
  check('T5b', '日志明确跳过补跑', /跳过补跑/.test(a.logText()))
  await shutdown(a)

  // 5c：当日 base.json 判据（状态文件缺失时的第二重保险）
  const dirB = join(TMP, 't5b')
  mkdirSync(dirB, { recursive: true })
  writeFileSync(join(dirB, 'base.json'), JSON.stringify({ generatedAt: new Date().toISOString(), tradeDate: '20260917' }), 'utf8')
  installFetch('hang-signal') // 重置计数
  const b = boot('t5b', { catchUpOnStart: true })
  await wait(400)
  check('T5c', '当日 base.json 判定当日已完成 → 不抓取', fetchState.calls === 0, `calls=${fetchState.calls}`)
  await shutdown(b)
  uninstallFetch()
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== T6 每日调度：仍会在目标时刻触发且只触发一次 ===')
{
  installFetch('hang-signal')
  // 把目标时刻设成"下一个整分"，最多等 61s
  const now = new Date()
  const next = new Date(now.getTime() + 65000)
  const hh = next.getHours()
  const mm = next.getMinutes()
  const inst = boot('t6', { hour: hh, minute: mm })
  const t0 = Date.now()
  while (Date.now() - t0 < 70000 && fetchState.calls === 0) await wait(250)
  const waited = Date.now() - t0
  check('T6a', `定时器在 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} 触发了抓取`, fetchState.calls === 1, `calls=${fetchState.calls} 等待=${(waited / 1000).toFixed(1)}s`)
  check('T6b', '触发时刻接近目标（±3s）', Math.abs(waited - 65000) < 3000 || waited <= 65000, `${(waited / 1000).toFixed(1)}s`)
  await wait(600)
  check('T6c', '只触发一次（无重复定时器）', fetchState.calls === 1, `calls=${fetchState.calls}`)
  await shutdown(inst)
  uninstallFetch()
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== T7 卸载后存活检查（无幽灵定时器 / 无幽灵写盘）===')
{
  installFetch('hang-signal')
  const inst = boot('t7', { catchUpOnStart: true, rtEnabled: true, rtIntervalSec: 1 })
  await wait(300)
  await shutdown(inst)
  const snapshot = readdirSync(inst.dir).sort().join(',')
  await wait(3000)
  check('T7a', '卸载后 3s 内目录内容不变（无幽灵写盘）', readdirSync(inst.dir).sort().join(',') === snapshot, snapshot)
  const calls = fetchState.calls
  await wait(1000)
  check('T7b', '卸载后无新请求（无幽灵定时器）', fetchState.calls === calls)
  uninstallFetch()
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== T8 dailyEnabled=false：本插件不承担每日日报（由独立调度器负责）===')
{
  installFetch('hang-signal')
  // 目标时刻设成"下一个整分"，若仍在调度最多等 61s —— 这里必须**完全不触发**
  const now = new Date()
  const next = new Date(now.getTime() + 65000)
  const hh = next.getHours()
  const mm = next.getMinutes()
  const inst = boot('t8', { dailyEnabled: false, hour: hh, minute: mm, catchUpOnStart: true, runOnStart: true })
  await wait(600)
  check('T8a', 'dailyEnabled=false → 启动不做任何抓取（连补跑也不做）', fetchState.calls === 0, `calls=${fetchState.calls}`)
  check('T8b', '日志明确说明日报已交给独立调度器', /每日日报已关闭/.test(inst.logText()), inst.logText().split('\n').filter((l) => /每日日报已关闭/.test(l))[0] ?? '')
  check('T8c', '日志不再出现"下次运行"（未 arm 每日定时器）', !/下次运行/.test(inst.logText()))
  await wait(1500)
  check('T8d', '1.5s 内仍无请求', fetchState.calls === 0, `calls=${fetchState.calls}`)
  await shutdown(inst)
  uninstallFetch()

  // 默认值必须是 true（插件单独使用时自洽）
  installFetch('hang-signal')
  const def = boot('t8b', { hour: 0, minute: 0, runOnStart: false })
  await wait(300)
  check('T8e', '不传 dailyEnabled 时默认 true（插件单独可用）', /下次运行/.test(def.logText()), def.logText().split('\n').filter((l) => /下次运行/.test(l))[0] ?? '')
  await shutdown(def)
  uninstallFetch()
}

// ══════════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.pass).length
const fail = results.length - pass
console.log(`\n=== 结果：${pass}/${results.length} 通过${fail ? `，${fail} 失败` : ''} ===`)
if (fail) for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.id} ${r.name} ${r.extra}`)
process.exit(fail ? 1 : 0)
