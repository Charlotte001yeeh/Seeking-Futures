#!/usr/bin/env node
/**
 * 一键启动（**不依赖 DSH**）：同一个 node 进程里同时跑
 *   ① 独立调度器 —— 每天 09:00 产出日报与 base.json
 *   ② 实时服务   —— 盘中轮询实时行情 + HTTP/SSE + 局域网前端
 *
 * 用法：
 *   node standalone/start.mjs                    # 默认端口 8899
 *   node standalone/start.mjs --port 9000
 *   node standalone/start.mjs --no-catchup       # 启动时不补跑当日日报
 *   node standalone/start.mjs --daily-only       # 只跑日报调度，不起前端
 *   node standalone/start.mjs --serve-only       # 只起前端，不跑日报调度
 *
 * 环境变量与 realtime-server 一致（RT_PORT / RT_INTERVAL_MS / RT_HOST ...）。
 */
import { networkInterfaces } from 'node:os'
import { pathToFileURL } from 'node:url'
import { startScheduler } from './scheduler.mjs'
import { DEFAULT_OUT_DIR, DEFAULT_VAR_DIR, WORKSPACE } from './daily-job.mjs'
import { config } from '../realtime-server/src/config.mjs'
import { main as startRealtime } from '../realtime-server/src/index.mjs'

function parseArgs(argv) {
  const get = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
  }
  return {
    port: get('port', null),
    host: get('host', null),
    hour: Number(get('hour', 9)),
    minute: Number(get('minute', 0)),
    outDir: get('out', DEFAULT_OUT_DIR),
    varDir: get('var', DEFAULT_VAR_DIR),
    lookbackDays: Number(get('lookback', 32)),
    catchUpOnStart: !argv.includes('--no-catchup'),
    dailyOnly: argv.includes('--daily-only'),
    serveOnly: argv.includes('--serve-only'),
  }
}

/** 取一个可给局域网用的 IPv4 */
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return null
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (args.port) process.env.RT_PORT = String(args.port)
  if (args.host) process.env.RT_HOST = String(args.host)

  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  期货 20 日涨跌幅 rank20 · 独立运行（不依赖 DSH）             ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log(`  工作区   : ${WORKSPACE}`)
  console.log(`  数据目录 : ${args.outDir}`)
  console.log(`  服务目录 : ${args.varDir}`)

  const cleanups = []

  if (!args.serveOnly) {
    const sched = startScheduler({
      hour: args.hour,
      minute: args.minute,
      outDir: args.outDir,
      varDir: args.varDir,
      lookbackDays: args.lookbackDays,
      catchUpOnStart: args.catchUpOnStart,
      log: (m) => console.log(`[daily] ${m}`),
    })
    cleanups.push(() => sched.stop())
    console.log(`  日报调度 : 每日 ${args.hour}:${String(args.minute).padStart(2, '0')}（启动${args.catchUpOnStart ? '会' : '不会'}补跑）`)
  }

  if (!args.dailyOnly) {
    const rt = await startRealtime({ installSignalHandlers: false })
    cleanups.push(() => rt.close())
    const port = rt.server.address()?.port ?? config.port
    const lan = lanAddress()
    console.log(`  实时服务 : http://127.0.0.1:${port}/`)
    if (lan) console.log(`  局域网   : http://${lan}:${port}/`)
    console.log(`  接口     : /api/health  /api/rank20/latest  /events(SSE)`)
    console.log('')
    console.log('  ★ 用浏览器打开上面的地址即可查看实时 rank20 看板')
  }

  const bye = () => {
    console.log('\n[standalone] 收到退出信号，正在停止…')
    void Promise.allSettled(cleanups.map((f) => Promise.resolve().then(f))).then(() => process.exit(0))
    setTimeout(() => process.exit(0), 4000)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
