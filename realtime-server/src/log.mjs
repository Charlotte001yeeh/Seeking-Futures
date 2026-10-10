/**
 * 极简日志：同时写 stdout 与 <varDir>/server.log（按大小滚动一次）。
 * 只写服务自己的目录，不碰别处。
 */
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.mjs'

const MAX_BYTES = 5 * 1024 * 1024

let logPath = ''
let ready = false

function ensure() {
  if (ready) return
  try {
    mkdirSync(config.varDir, { recursive: true })
    logPath = join(config.varDir, 'server.log')
    if (existsSync(logPath) && statSync(logPath).size > MAX_BYTES) {
      renameSync(logPath, join(config.varDir, 'server.log.1'))
    }
  } catch {
    /* 日志不可用不影响主流程 */
  }
  ready = true
}

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

function emit(level, msg) {
  const line = `[${ts()}] ${level} ${msg}`
  if (level === 'ERROR') console.error(line)
  else console.log(line)
  ensure()
  try {
    if (logPath) appendFileSync(logPath, line + '\n')
  } catch {
    /* ignore */
  }
}

export const log = {
  info: (m) => emit('INFO ', m),
  warn: (m) => emit('WARN ', m),
  error: (m) => emit('ERROR', m),
  /** 进程内的环形缓冲，供 /api/health 展示最近日志 */
  recent: [],
}
const push = log.recent.push.bind(log.recent)
for (const k of ['info', 'warn', 'error']) {
  const orig = log[k]
  log[k] = (m) => {
    push({ t: new Date().toISOString(), level: k, msg: String(m) })
    if (log.recent.length > 200) log.recent.shift()
    orig(m)
  }
}
