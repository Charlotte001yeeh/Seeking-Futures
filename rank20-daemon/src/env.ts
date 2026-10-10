/**
 * 运行时凭据 / 环境配置（**零依赖**，不读 ~/.dsh，不依赖任何插件）
 *
 * 设计要点：
 *   1. 源码里**不允许**出现任何真实凭据 —— 上传 GitHub 时会一并泄漏，且无法通过
 *      "改一行再提交"补救（历史里还在）。凭据一律从环境变量 / `.env` 读取。
 *   2. `.env` 是**可选**的便捷方式：启动时从工作区根目录读一次，**不覆盖**已存在的
 *      真实环境变量（容器/CI 里注入的优先级更高）。
 *   3. 缺凭据时必须**明确报错并给出获取方式**，绝不静默降级 —— 大商所（DCE）数据缺失
 *      会让六大交易所的完整性校验不通过，最终榜单不完整。
 *
 * 支持的变量见仓库根目录 `.env.example`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本文件位于 <repo>/rank20-daemon/{src,dist}/env.* → 工作区根目录 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, '.env.example')) || existsSync(join(dir, 'README.md'))) return dir
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return process.cwd()
}

/** 极简 .env 解析（支持 `KEY=value`、`#` 注释、单双引号、行内 `#` 注释） */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    const quoted = /^(['"])(.*)\1$/.exec(val)
    if (quoted) val = quoted[2]
    else val = val.replace(/\s+#.*$/, '').trim()
    out[key] = val
  }
  return out
}

let loaded = false

/** 载入工作区根目录的 .env（只填未设置的变量；文件不存在则跳过） */
export function loadEnvFile(file = join(findRepoRoot(), '.env')): void {
  if (loaded) return
  loaded = true
  try {
    if (!existsSync(file)) return
    for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (process.env[k] === undefined) process.env[k] = v
    }
  } catch {
    /* .env 不可读不算致命：真实环境变量仍然有效 */
  }
}

/** 读一个环境变量（首次调用时会顺带加载 .env） */
export function env(name: string, fallback = ''): string {
  loadEnvFile()
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

// ── 大商所（DCE）官方 API 凭据 ──────────────────────────────────────────────
/** 凭据在官网免费注册后获得：https://www.dce.com.cn/ （数据 → API 服务） */
export interface DceCredentials {
  apiKey: string
  secret: string
  host: string
}

/** DCE API 默认主机（可被 DCE_HOST 覆盖，便于自建代理） */
export const DCE_DEFAULT_HOST = 'www.dce.com.cn'

/**
 * 取 DCE 凭据。
 * @throws 未配置时抛出**可操作**的错误（含获取方式与 .env 示例），不静默降级。
 */
export function dceCredentials(): DceCredentials {
  const apiKey = env('DCE_API_KEY')
  const secret = env('DCE_SECRET')
  const host = env('DCE_HOST', DCE_DEFAULT_HOST)
  const missing = [!apiKey && 'DCE_API_KEY', !secret && 'DCE_SECRET'].filter(Boolean) as string[]
  if (missing.length) {
    throw new Error(
      `未配置大商所（DCE）官方 API 凭据：缺少 ${missing.join(' / ')}。\n` +
        '  · 官网免费注册后获取：https://www.dce.com.cn/ → 数据 → API 服务\n' +
        '  · 然后在仓库根目录建 .env（可从 .env.example 复制）：\n' +
        '        DCE_API_KEY=你的apikey\n' +
        '        DCE_SECRET=你的secret\n' +
        '  · 或直接设置同名环境变量（CI/容器里推荐）',
    )
  }
  return { apiKey, secret, host }
}
