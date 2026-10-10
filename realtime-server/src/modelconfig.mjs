/**
 * 模型 API 配置（服务端持有，**密钥不回传前端**）
 *
 * 安全约定（局域网内部自用，无登录态）：
 *   · API Key 只存在服务端自己的数据目录 <varDir>/model.json（权限 0600）
 *   · GET /api/model/config 只返回掩码（如 `sk-…3f9c`）与 hasKey 布尔，**绝不明文回传**
 *   · 前端输入框是 type=password，提交后立即清空；再次保存时留空 = 保持原 Key 不变
 *   · 连通性测试在服务端发起，前端拿不到 Key
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.mjs'
import { log } from './log.mjs'

const FILE = () => join(config.varDir, 'model.json')

/** 内存态：{ baseUrl, model, apiKey, savedAt } */
let state = null

function load() {
  if (state) return state
  state = { baseUrl: '', model: '', apiKey: '', savedAt: null }
  try {
    const p = FILE()
    if (existsSync(p)) {
      const doc = JSON.parse(readFileSync(p, 'utf8'))
      state = {
        baseUrl: String(doc.baseUrl ?? ''),
        model: String(doc.model ?? ''),
        apiKey: String(doc.apiKey ?? ''),
        savedAt: doc.savedAt ?? null,
      }
    }
  } catch (e) {
    log.warn(`读取模型配置失败：${e instanceof Error ? e.message : e}`)
  }
  return state
}

function persist() {
  const s = load()
  try {
    mkdirSync(config.varDir, { recursive: true })
    const p = FILE()
    writeFileSync(p, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(p, 0o600) // Windows 上无效但不报错；POSIX 下收紧权限
    } catch {
      /* ignore */
    }
  } catch (e) {
    log.warn(`保存模型配置失败：${e instanceof Error ? e.message : e}`)
  }
}

/** 掩码：只露头 3 尾 4，中间固定长度星号（不泄露真实长度） */
export function maskKey(key) {
  const k = String(key ?? '')
  if (!k) return ''
  if (k.length <= 8) return '****'
  return `${k.slice(0, 3)}${'*'.repeat(8)}${k.slice(-4)}`
}

/** 给前端的**安全**视图：永不含明文 Key */
export function publicConfig() {
  const s = load()
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    hasKey: !!s.apiKey,
    keyMasked: maskKey(s.apiKey),
    savedAt: s.savedAt,
    storePath: FILE(),
  }
}

/**
 * 保存配置。apiKey 省略或留空 = 保持原值（前端不需要回填明文）。
 * @returns {{ok:boolean, error?:string}}
 */
export function saveConfig({ baseUrl, model, apiKey }) {
  const s = load()
  if (baseUrl !== undefined) s.baseUrl = String(baseUrl).trim()
  if (model !== undefined) s.model = String(model).trim()
  if (apiKey !== undefined && String(apiKey).length > 0) s.apiKey = String(apiKey).trim()
  if (s.baseUrl && !/^https?:\/\//i.test(s.baseUrl)) {
    return { ok: false, error: '接口地址必须以 http:// 或 https:// 开头' }
  }
  s.savedAt = new Date().toISOString()
  persist()
  log.info(`模型配置已保存（baseUrl=${s.baseUrl || '(空)'} model=${s.model || '(空)'} key=${s.hasOwnProperty('apiKey') && s.apiKey ? maskKey(s.apiKey) : '(无)'}）`)
  return { ok: true, config: publicConfig() }
}

/** 清除 Key */
export function clearKey() {
  const s = load()
  s.apiKey = ''
  s.savedAt = new Date().toISOString()
  persist()
  return publicConfig()
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`请求超时（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 模型连通性测试（OpenAI 兼容协议）。
 * 优先 POST {baseUrl}/chat/completions（最小 1 token）；失败再退回 GET {baseUrl}/models。
 * @returns {Promise<object>} 结果里**不含** apiKey
 */
export async function testModel(override = {}) {
  const s = load()
  const baseUrl = (String(override.baseUrl ?? '').trim() || String(s.baseUrl ?? '').trim()).replace(/\/+$/, '')
  // 空白视为"未提供"，回退到已保存的值（前端留空 = 不改）
  const apiKey = String(override.apiKey ?? '').trim() || String(s.apiKey ?? '').trim()
  const model = String(override.model ?? '').trim() || String(s.model ?? '').trim()
  if (!baseUrl) return { ok: false, error: '未配置接口地址' }
  if (!apiKey) return { ok: false, error: '未配置 API Key' }

  const attempts = []
  const t0 = Date.now()

  // ① chat/completions（最贴近真实用法的探活）
  if (model) {
    const url = `${baseUrl}/chat/completions`
    const started = Date.now()
    try {
      const res = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
          }),
        }),
        20000,
      )
      const text = await res.text()
      const latencyMs = Date.now() - started
      if (res.ok) {
        let reply = ''
        try {
          const j = JSON.parse(text)
          reply = j?.choices?.[0]?.message?.content ?? ''
        } catch {
          /* 非 JSON 也算通 */
        }
        return {
          ok: true,
          via: 'chat/completions',
          url,
          status: res.status,
          latencyMs,
          elapsedMs: Date.now() - t0,
          model,
          reply: String(reply).slice(0, 60),
          note: '模型已响应（消耗 1 token 以内）',
        }
      }
      attempts.push({ via: 'chat/completions', url, status: res.status, latencyMs, body: text.slice(0, 300) })
    } catch (e) {
      attempts.push({ via: 'chat/completions', url, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ② models 列表（多数 OpenAI 兼容服务都支持）
  {
    const url = `${baseUrl}/models`
    const started = Date.now()
    try {
      const res = await withTimeout(
        fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } }),
        15000,
      )
      const text = await res.text()
      const latencyMs = Date.now() - started
      if (res.ok) {
        let models = []
        try {
          models = (JSON.parse(text)?.data ?? []).map((m) => m.id).slice(0, 30)
        } catch {
          /* ignore */
        }
        return {
          ok: true,
          via: 'models',
          url,
          status: res.status,
          latencyMs,
          elapsedMs: Date.now() - t0,
          models,
          note: model
            ? `接口可达；但未验证具体模型「${model}」（chat/completions 未成功，见 attempts）`
            : '接口可达',
          attempts,
        }
      }
      attempts.push({ via: 'models', url, status: res.status, latencyMs, body: text.slice(0, 300) })
    } catch (e) {
      attempts.push({ via: 'models', url, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return {
    ok: false,
    elapsedMs: Date.now() - t0,
    error: '两个探测端点都未成功',
    hint: '检查：接口地址是否含 /v1、Key 是否有效、服务是否需要代理、模型名是否正确',
    attempts,
  }
}
