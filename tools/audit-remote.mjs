/**
 * 远端仓库安全审计：**检查 GitHub 上实际存在的内容**，而不是本地工作区
 *
 * 为什么需要单独一个工具：
 *   · 本地 `git status` 干净 ≠ 远端干净。已删除的文件仍可能在**历史提交**里（GitHub 永久保留）。
 *   · 因此做法是 `git clone --mirror` 一份远端，然后遍历**所有 ref / 所有提交 / 所有 blob**
 *     以及提交元数据（作者/邮箱/提交信息），做敏感信息与个人信息扫描。
 *
 * 用法：
 *   node tools/audit-remote.mjs                     # 用 origin 的 URL
 *   node tools/audit-remote.mjs <git-url>           # 指定仓库
 *   node tools/audit-remote.mjs --keep              # 保留克隆目录以便人工排查
 *
 * 退出码：发现高危项 → 1；只有"提示级"项 → 0。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLONE = join(ROOT, 'tools', 'var-remote') // 已被 .gitignore 忽略（tools/var-*/）
const KEEP = process.argv.includes('--keep')
const argUrl = process.argv.slice(2).find((a) => !a.startsWith('--'))

const git = (args, cwd = ROOT) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

/** 从 .env 读出**本机真实凭据值**，作为最高优先级的比对目标（不打印明文） */
function localSecretValues() {
  const p = join(ROOT, '.env')
  if (!existsSync(p)) return []
  return [
    ...new Set(
      readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => l.slice(l.indexOf('=') + 1).trim())
        .filter((v) => v.length >= 6),
    ),
  ]
}

const SECRET_VALUES = localSecretValues()

/** 通用敏感/个人信息模式（level: 'h' 高危 / 'i' 提示级） */
const PATTERNS = [
  // ── 凭据（高危）──
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, label: 'OpenAI 风格 API Key', level: 'h' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, label: 'GitHub Token', level: 'h' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key', level: 'h' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: '私钥', level: 'h' },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, label: 'JWT（可能含凭据）', level: 'h' },
  { re: /(?:api[_-]?key|apikey|secret|token|passwd|password)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, label: '凭据字面量', level: 'h' },
  { re: /\bDCE_(?:API_KEY|SECRET)\s*[:=]\s*['"][^'"]{4,}['"]/, label: 'DCE 凭据硬编码', level: 'h' },
  // 手机号/身份证：必须**不被数字或逗号包围**，否则会命中行情数据里的成交额/持仓量
  // （实测踩过：文档里的日线样例 `...,643026,19919084032,...` 被当成 11 位手机号）
  { re: /(?<![\d,.\-])1[3-9]\d{9}(?![\d,.])/, label: '中国大陆手机号', level: 'h' },
  { re: /(?<![\d,.\-])\d{17}[\dXx](?![\d,.])/, label: '身份证号', level: 'h' },
  // ── 个人/环境信息（提示级；部分属于"设计使然"）──
  { re: /[A-Za-z]:\\+Users\\+[^\\/\s'"<]+/, label: 'Windows 用户绝对路径（含用户名）', level: 'i' },
  { re: /[A-Za-z]:\\+[A-Za-z0-9_]+\\+[A-Za-z0-9_.-]+\\+/, label: '本机绝对路径', level: 'i' },
  { re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//, label: 'POSIX 家目录路径', level: 'i' },
  { re: /\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, label: '内网 IP', level: 'i' },
  { re: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, label: '内网 IP', level: 'i' },
]

/**
 * 允许的例外：占位符、示例、以及**测试夹具里自造的假值**。
 * 审计工具必须"不喊狼来了"——否则没人会认真看它的输出。
 */
function isAllowed(line) {
  if (/<API_KEY>|<SECRET>|<repo>|<name>|<user>|<path-to>|<your-repo-url>/.test(line)) return true
  if (/sk-\*\*\*|sk-\.\.\.|你的api|placeholder|示例|e\.g\.|例如/.test(line)) return true
  if (/\$\{|\bxxx+\b/i.test(line)) return true
  // 测试夹具：设置环境变量的赋值语句（不是硬编码凭据）
  if (/process\.env\.[A-Z0-9_]+\s*=/.test(line)) return true
  // 测试夹具：明显自造的假 Key（含 verify/test/fake/dummy/example 或 unit-/other- 前缀）
  if (/sk-(verify|ui-verify|other|test|fake|dummy|example)|['"](?:unit|test|fake|dummy)-(?:key|secret)['"]/i.test(line)) return true
  return false
}

const results = []
const check = (id, name, cond, extra = '') => {
  results.push({ id, name, pass: !!cond, extra })
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

// ══════════════════════════════════════════════════════════════════════════
const url = argUrl ?? (git(['remote', 'get-url', 'origin']).stdout ?? '').trim()
console.log(`\n═══ 远端仓库安全审计 ═══\n  仓库: ${url}\n`)

if (!url || !/^(https?:\/\/|git@)/.test(url)) {
  console.log('  ✗ 未找到有效的远端 URL（可显式传入）')
  process.exit(1)
}

console.log('【0】克隆远端（mirror，含全部 ref 与历史）')
rmSync(CLONE, { recursive: true, force: true })
mkdirSync(CLONE, { recursive: true })
{
  // 出网偶发抖动（early EOF / connection reset）→ 重试几次
  let lastErr = ''
  let ok = false
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
    rmSync(CLONE, { recursive: true, force: true })
    mkdirSync(CLONE, { recursive: true })
    const r = git(['-c', 'http.postBuffer=524288000', 'clone', '--mirror', '--quiet', url, CLONE])
    if (r.status === 0) {
      ok = true
      console.log(`  ✓ 已克隆到 ${CLONE.replace(ROOT, '.')}${attempt > 1 ? `（第 ${attempt} 次尝试成功）` : ''}`)
      break
    }
    lastErr = (r.stderr ?? '').trim().split('\n').slice(-2).join(' ')
    if (attempt < 4) {
      console.log(`  · 第 ${attempt} 次克隆失败（${lastErr}），4s 后重试…`)
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},4200)'], { stdio: 'ignore' })
    }
  }
  if (!ok) {
    console.log(`  ✗ 克隆失败（已重试 4 次）：${lastErr}`)
    console.log('    提示：这是出网问题，不代表仓库有问题。可稍后重跑本脚本。')
    process.exit(1)
  }
}

const G = (args) => git(args, CLONE)
const sh = (args) => (G(args).stdout ?? '').trim()

// ── 1 refs ────────────────────────────────────────────────────────────────
console.log('\n【1】远端全部 ref')
{
  const refs = sh(['show-ref']).split('\n').filter(Boolean)
  console.log(`  共 ${refs.length} 个 ref`)
  for (const r of refs) console.log(`    ${r}`)
  const branches = refs.filter((r) => r.includes('refs/heads/')).map((r) => r.split('refs/heads/')[1])
  check('R1', `只有 main 分支（实际：${branches.join(', ') || '无'}）`, branches.length === 1 && branches[0] === 'main')
  const tags = refs.filter((r) => r.includes('refs/tags/'))
  check('R2', '没有多余 tag', tags.length === 0, tags.map((t) => t.split('refs/tags/')[1]).join(',') || '无')
}

// ── 2 提交历史与元数据 ────────────────────────────────────────────────────
console.log('\n【2】提交历史与元数据（作者/邮箱会永久留在 GitHub）')
{
  const log = sh(['log', '--all', '--reverse', '--format=%h|%an|%ae|%cn|%ce|%ad|%s'])
  const rows = log.split('\n').filter(Boolean).map((l) => l.split('|'))
  console.log(`  共 ${rows.length} 个提交`)
  for (const [h, an, ae, cn, ce, ad, s] of rows) {
    console.log(`    ${h}  ${ad}`)
    console.log(`        author    ${an} <${ae}>`)
    console.log(`        committer ${cn} <${ce}>`)
    console.log(`        ${s}`)
  }
  const emails = [...new Set(rows.flatMap((r) => [r[2], r[4]]))]
  check('R3', `提交元数据里的邮箱（${emails.length} 个）：${emails.join(', ')}`, true, '提示级：GitHub 上公开可见，属预期')
  check('R4', '提交元数据里没有占位/错误身份', !emails.some((e) => /dev@localhost|rank20-dev/.test(e)), emails.join(','))
}

// ── 3 遍历所有 blob ───────────────────────────────────────────────────────
console.log('\n【3】遍历历史里的每一个 blob（含已删除文件）')
const blobs = new Map() // sha → [paths]
{
  const objs = sh(['rev-list', '--objects', '--all'])
  for (const line of objs.split('\n').filter(Boolean)) {
    const [sha, ...rest] = line.split(' ')
    if (!/^[0-9a-f]{40}$/.test(sha)) continue
    const type = sh(['cat-file', '-t', sha])
    if (type !== 'blob') continue
    const p = rest.join(' ') || `(无路径 ${sha.slice(0, 8)})`
    if (!blobs.has(sha)) blobs.set(sha, [])
    blobs.get(sha).push(p)
  }
  console.log(`  历史中不同 blob 共 ${blobs.size} 个`)
}

/** 读 blob 内容（二进制会包含 NUL，按二进制标记处理） */
function blobText(sha) {
  const r = git(['cat-file', 'blob', sha], CLONE)
  return r.stdout ?? ''
}

const envValueHits = [] // 命中"本机 .env 里的真实值" —— 最高优先级
const patternHits = [] // 命中通用模式
const personalHits = [] // 提示级：个人/环境信息
for (const [sha, paths] of blobs) {
  const text = blobText(sha)
  if (text.includes('\u0000')) {
    personalHits.push(`(二进制文件，未扫描内容) ${paths.join(', ')}`)
    continue
  }
  const where = paths.join(', ')
  for (const v of SECRET_VALUES) {
    if (text.includes(v)) envValueHits.push(`${where}  含本机 .env 里的值「${v.slice(0, 3)}***」`)
  }
  text.split('\n').forEach((line, i) => {
    if (isAllowed(line)) return
    for (const { re, label, level } of PATTERNS) {
      if (!re.test(line)) continue
      const item = `${where}:${i + 1}  [${label}]  ${line.trim().slice(0, 110)}`
      if (level === 'h') patternHits.push(item)
      else personalHits.push(item)
    }
  })
}

check(
  'R5',
  `**历史里没有任何本机 .env 凭据值**（逐个比对 .env 的 ${SECRET_VALUES.length} 个值）`,
  envValueHits.length === 0,
  envValueHits.join('\n      ') || '全文比对通过',
)
check('R6', '历史里没有其它高危凭据（API Key / Token / 私钥 / 手机号 / 身份证）', patternHits.length === 0,
  patternHits.slice(0, 20).join('\n      ') || '无')

check('R7', '历史里没有个人环境信息（绝对路径 / 内网 IP / 用户名）', personalHits.length === 0,
  personalHits.slice(0, 20).join('\n      ') || '无')

// ── 4 当前 HEAD 树清单 ────────────────────────────────────────────────────
console.log('\n【4】当前 main 树（GitHub 上"看得见"的文件）')
{
  const files = sh(['ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean)
  console.log(`  共 ${files.length} 个文件`)
  const forbidden = files.filter((f) =>
    /(^|\/)\.env$|node_modules|^rank20\/|\.docx$|super-injector|(^|\/)var-|\.log$|model\.json$|\.pem$|\.key$/.test(f),
  )
  check('R8', '不包含 .env / 运行时数据 / 依赖目录 / 第三方源码', forbidden.length === 0, forbidden.join(', ') || '无')
  const suspicious = files.filter((f) => /credential|secret|password|token|\.p12$|id_rsa/i.test(f))
  check('R9', '文件名里没有凭据类命名', suspicious.length === 0, suspicious.join(', ') || '无')
}

// ── 5 收尾 ────────────────────────────────────────────────────────────────
if (!KEEP) rmSync(CLONE, { recursive: true, force: true })

const high = results.filter((r) => !r.pass)
const pass = results.filter((r) => r.pass).length
console.log(`\n═══ 结果：${pass}/${results.length} 项通过${high.length ? `，${high.length} 项需处理` : ''} ═══`)
for (const r of high) console.log(`  ✗ ${r.id} ${r.name}`)
if (personalHits.length) console.log(`\n提示级发现 ${personalHits.length} 条（多为"设计使然"，逐条看上面 R7/R3 输出）`)
console.log('')
process.exit(high.length ? 1 : 0)
