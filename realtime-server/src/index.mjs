/**
 * realtime-server 入口：装配 基准表监视器 → 轮询器 → 快照中心 → HTTP/SSE 服务。
 *
 * 独立启动：  node src/index.mjs
 * 被复合启动：import { main } from '.../index.mjs'; await main()   （standalone/start.mjs 用）
 * 环境变量见 src/config.mjs（RT_PORT / RT_INTERVAL_MS / RT_MAX_RPS ...）
 */
import { pathToFileURL } from 'node:url'
import { config } from './config.mjs'
import { log } from './log.mjs'
import { BaseWatcher } from './base.mjs'
import { SnapshotHub } from './snapshot.mjs'
import { Store } from './store.mjs'
import { Poller } from './poller.mjs'
import { startServer } from './server.mjs'

/**
 * 启动实时服务。
 * @param {{ installSignalHandlers?: boolean }} [opts]
 *        installSignalHandlers=false 时由调用方（复合启动器）负责收尾。
 * @returns {Promise<{ server: import('node:http').Server, poller: Poller, hub: SnapshotHub, baseWatcher: BaseWatcher, close: () => Promise<void> }>}
 */
export async function main(opts = {}) {
  log.info('=== realtime-server 启动 ===')
  log.info(`基准表：${config.baseFile}`)
  log.info(`产物目录：${config.outDir}`)
  log.info(`服务目录：${config.varDir}`)
  log.info(
    `节拍：${config.poll.intervalMs}ms（无变化 ${config.poll.idleRoundsToBackoff} 轮后退避到 ${config.poll.backoffMs}ms）`,
  )
  log.info(
    `闸门：≤${config.gates.maxReqPerSec} req/s，≤${config.gates.maxReqPerMin} req/min，≤${config.gates.maxReqPerDay} req/日`,
  )

  const store = new Store()
  const hub = new SnapshotHub()
  const baseWatcher = new BaseWatcher(config.baseFile)
  const poller = new Poller(baseWatcher, hub, store)

  const server = await startServer({ poller, hub, baseWatcher })
  poller.start()

  const close = async () => {
    poller.stop()
    await new Promise((r) => server.close(() => r()))
  }

  if (opts.installSignalHandlers !== false) {
    const shutdown = (sig) => {
      log.info(`收到 ${sig}，正在停止…`)
      void close().then(() => process.exit(0))
      setTimeout(() => process.exit(0), 3000)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('uncaughtException', (e) => log.error(`未捕获异常：${e.stack ?? e.message}`))
    process.on('unhandledRejection', (e) => log.error(`未处理的 Promise 拒绝：${e}`))
  }

  return { server, poller, hub, baseWatcher, close }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((e) => {
    log.error(`启动失败：${e.stack ?? e.message}`)
    process.exit(1)
  })
}
