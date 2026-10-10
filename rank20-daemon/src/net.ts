/**
 * 网络层：统一 HTTP 客户端 + 限流 + 重试 + **可取消**。
 *
 * ⚠️ 关键：必须走 Node 原生 fetch（undici / OpenSSL）。
 * 本机 curl 的 Windows Schannel TLS 后端故障（SEC_E_NO_CREDENTIALS），
 * 所有 HTTPS 请求 exit 35 —— 详见 docs/05-网络出口修复与口径验证.md。
 *
 * 取消语义（配合插件生命周期）：
 *   · 每个插件实例持有一个 AbortController；dispose 时 abort()
 *   · signal 一路透传到 fetch、重试等待（sleep）与限流等待
 *   · 取消导致的失败抛 CancelledError，**不是业务失败**，调用方应静默退出
 */
import { UA } from './types.js'

const lastHit: Record<string, number> = {}

/** 取消（正常卸载）专用错误：调用方据此区分"业务失败"与"实例已停止" */
export class CancelledError extends Error {
  constructor(message = 'aborted') {
    super(message)
    this.name = 'CancelledError'
  }
}

/** 判定一个异常是否为取消引起（含 undici 抛出的 AbortError） */
export function isCancelled(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return e.name === 'CancelledError' || e.name === 'AbortError'
}

/** 可取消的 sleep */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError('sleep aborted'))
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new CancelledError('sleep aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 同域名最小请求间隔（ms） */
const MIN_GAP: Record<string, number> = {
  'www.dce.com.cn': 2600, // DCE 限流：过快触发"超出访问频次，已停止访问60秒"
  'www.gfex.com.cn': 900,
}
const DEFAULT_GAP = 250

async function throttle(host: string, signal?: AbortSignal): Promise<void> {
  const gap = MIN_GAP[host] ?? DEFAULT_GAP
  const wait = (lastHit[host] ?? 0) + gap - Date.now()
  if (wait > 0) await sleep(wait, signal)
  lastHit[host] = Date.now()
}

export interface FetchOptions {
  method?: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  /** 最大尝试次数（含首次） */
  retries?: number
  /** 单次尝试超时 ms */
  timeoutMs?: number
  /** 外部取消信号（插件实例的 AbortController） */
  signal?: AbortSignal
}

/** 统一抓取：限流 → 请求 → 重试 → 返回文本 */
export async function httpText(url: string, opt: FetchOptions = {}): Promise<string> {
  const host = new URL(url).hostname
  const retries = opt.retries ?? 3
  const timeoutMs = opt.timeoutMs ?? 30_000
  const outer = opt.signal
  let lastErr = ''

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (outer?.aborted) throw new CancelledError('httpText aborted before attempt')
    await throttle(host, outer)

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    // 外部取消 与 单次超时 合并
    const signal = outer ? AbortSignal.any([outer, ac.signal]) : ac.signal
    try {
      const headers: Record<string, string> = { 'User-Agent': UA, ...(opt.headers ?? {}) }
      if (opt.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
      const res = await fetch(url, {
        method: opt.method ?? 'GET',
        headers,
        body: opt.body,
        signal,
      })
      clearTimeout(timer)
      const text = await res.text()
      if (res.ok && text.length > 0) return text
      lastErr = `HTTP ${res.status} len=${text.length}`
    } catch (e) {
      clearTimeout(timer)
      // 外部取消 → 直接冒泡，不重试、不算业务失败
      if (outer?.aborted) throw new CancelledError(`httpText aborted: ${url}`)
      lastErr = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
    if (attempt < retries) await sleep(1200 * attempt, outer)
  }
  throw new Error(`fetch failed after ${retries} tries: ${url} (${lastErr})`)
}

/** 抓取并解析 JSON */
export async function httpJson<T = unknown>(url: string, opt: FetchOptions = {}): Promise<T> {
  const text = await httpText(url, opt)
  return JSON.parse(text) as T
}
