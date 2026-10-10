/**
 * 发布前审计（上传 GitHub 前的强制关卡）
 *
 *   A 敏感信息：硬编码密钥 / token / 口令 / 私钥
 *   B 个人环境：绝对路径、用户名、机器名、内网地址
 *   C 运行时产物：日志、状态、生成的数据文件是否会被误提交
 *   D 仓库清单：将被纳入版本控制的文件（体积 / 数量 / 最大文件）
 *
 * 用法：
 *   node tools/audit-publish.mjs            # 审计工作区（按 .gitignore 规则判断"会提交什么"）
 *   node tools/audit-publish.mjs --all      # 连被忽略的文件一起统计
 *
 * 退出码：发现问题 → 1；干净 → 0。可直接挂到 CI / pre-push。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SHOW_ALL = process.argv.includes('--all')

// ── 会被忽略的目录（与 .gitignore 保持一致）──────────────────────────────
// 注意：`var*` 用模式匹配（.gitignore 里是 `*/var-*/` 与 `var/`），
// 否则新增一个 var-backup / var-remote 目录就会让审计误报"产物会被提交"。
const IGNORED_DIR_RE = /^(?:node_modules|\.git|\.vscode|\.idea|var(?:-.*)?)$/
/** 运行时数据目录（排行榜产物 + K 线库；由每日任务生成，不入库） */
const RUNTIME_DATA_DIRS = new Set(['rank20'])
/** 不发布的文件（交易所官方文档等，版权归原方） */
const IGNORED_FILE_RE = /\.(docx|xlsx|pdf)$/i

const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.json', '.yml', '.yaml', '.md', '.html', '.css', '.txt', '.env', '.example', '.sh', '.ps1'])

const results = []
const check = (id, name, cond, extra = '') => {
  results.push({ id, name, pass: !!cond, extra })
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

/** 不随仓库再分发 / 非产品目录（与 .gitignore 一致，但要能同时匹配任意层级） */
const IGNORED_PATH_RE = /^(?:super-injector-src|out)$/

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    // rank20-daemon/lib/ 是 esbuild 产物（可选 DSH 适配壳），由嵌套 .gitignore 忽略
    if (e.isDirectory() && relative(ROOT, p).replace(/\\/g, '/') === 'rank20-daemon/lib') continue
    if (e.isDirectory()) {
      if (IGNORED_DIR_RE.test(e.name) || IGNORED_PATH_RE.test(e.name)) continue
      if (RUNTIME_DATA_DIRS.has(e.name) && !SHOW_ALL) continue
      walk(p, acc)
    } else {
      if (IGNORED_FILE_RE.test(e.name)) continue
      acc.push(p)
    }
  }
  return acc
}

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')
const allFiles = walk(ROOT)
const textFiles = allFiles.filter((f) => TEXT_EXT.has(extname(f).toLowerCase()) || !extname(f))

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== A 敏感信息（硬编码凭据）===')
{
  /** 每个模式都要能同时抓"赋值给字面量"与"典型密钥形状" */
  const PATTERNS = [
    [/sk-[A-Za-z0-9_-]{16,}/, '疑似 API Key（sk-…）'],
    [/gh[pousr]_[A-Za-z0-9]{20,}/, '疑似 GitHub Token'],
    [/AKIA[0-9A-Z]{16}/, '疑似 AWS Access Key'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
    [/\b(?:api[_-]?key|apikey|secret|token|passwd|password)\s*[:=]\s*['"][^'"\s]{6,}['"]/i, '凭据字面量赋值'],
    [/\bDCE_(?:API_KEY|SECRET)\s*[:=]\s*['"][^'"]+['"]/, 'DCE 官方 API 凭据硬编码'],
  ]
  const hits = []
  for (const f of textFiles) {
    let txt
    try {
      txt = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    const lines = txt.split('\n')
    for (const [re, label] of PATTERNS) {
      lines.forEach((line, i) => {
        // 允许的例外：测试夹具里的假 Key、文档里的占位符、扫描器自身的模式定义
        if (/sk-(verify|ui-verify|other)|sk-\.\.\.|sk-\*|示例|placeholder|your[_-]?key|xxx+|\$\{/i.test(line)) return
        // 允许：往 process.env 里**写入**（测试夹具设置环境变量，不是硬编码凭据）
        if (/process\.env\.[A-Z0-9_]+\s*=/.test(line)) return
        if (re.test(line)) hits.push(`${rel(f)}:${i + 1}  [${label}]  ${line.trim().slice(0, 100)}`)
      })
    }
  }
  check('A1', '源码/文档中没有硬编码凭据', hits.length === 0, hits.length ? `\n      ${hits.join('\n      ')}` : `扫描 ${textFiles.length} 个文本文件`)

  /*
   * A1b：**用你自己的 .env 反查**。
   * 模式匹配永远可能漏（例如文档里写成表格、日志片段、JWT payload）。
   * 但"我的真实凭据值"是已知的 —— 直接拿 .env 里的每个值去全文比对，
   * 任何格式的泄漏都能抓到。这一条是本审计最重要的兜底。
   */
  const envPath = join(ROOT, '.env')
  if (existsSync(envPath)) {
    const values = [
      ...new Set(
        readFileSync(envPath, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && l.includes('='))
          .map((l) => l.slice(l.indexOf('=') + 1).trim())
          .filter((v) => v.length >= 6),
      ),
    ]
    const leaks = []
    for (const f of textFiles) {
      if (rel(f) === '.env') continue
      let txt
      try {
        txt = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      for (const v of values) {
        if (txt.includes(v)) leaks.push(`${rel(f)}  含 .env 里的值「${v.slice(0, 3)}***」`)
      }
    }
    check('A1b', `.env 里的 ${values.length} 个凭据值没有出现在任何其它文件`, leaks.length === 0,
      leaks.length ? `\n      ${[...new Set(leaks)].join('\n      ')}` : '全文比对通过')
  } else {
    check('A1b', '.env 不存在（跳过反查）', true, '本机未配置 .env')
  }

  // .env 允许存在于本地（开发机要用），但必须被 .gitignore 忽略 —— 即"不会被提交"
  const envFiles = allFiles.filter((f) => /(^|[\\/])\.env$/.test(f))
  const giText = existsSync(join(ROOT, '.gitignore')) ? readFileSync(join(ROOT, '.gitignore'), 'utf8') : ''
  const envIgnored = /^\.env$/m.test(giText)
  check('A2', '.env 不会被提交（存在则必须被 .gitignore 忽略）', envFiles.length === 0 || envIgnored,
    envFiles.length ? `本地存在 .env（已忽略=${envIgnored}，仅本机使用）` : '无 .env')
  check('A3', '提供了 .env.example 模板', existsSync(join(ROOT, '.env.example')))
  check('A4', '.gitignore 忽略 .env 与运行时数据', envIgnored && /^rank20\/?$/m.test(giText) && /node_modules/.test(giText))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== B 个人环境信息（绝对路径 / 用户名）===')
{
  const PATTERNS = [
    [/[A-Za-z]:\\+Users\\+[^\\/\s'"]+/, 'Windows 用户绝对路径'],
    [/[A-Za-z]:\\+DS\\+/, '本机 DSH 检出路径'],
    [/\/(?:Users|home)\/[A-Za-z0-9._-]+\//, 'POSIX 家目录绝对路径'],
    [/\bIDATA\b/, '本机用户名'],
  ]
  const hits = []
  for (const f of textFiles) {
    let txt
    try {
      txt = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    txt.split('\n').forEach((line, i) => {
      for (const [re, label] of PATTERNS) {
        // 允许：文档/脚本里明确写的"示例路径"占位（含 <user> 或 …）
        if (/Users[\\/]<|Users[\\/]…|<username>|示例|e\.g\.|例如/.test(line)) continue
        if (re.test(line)) {
          hits.push(`${rel(f)}:${i + 1}  [${label}]  ${line.trim().slice(0, 96)}`)
          break
        }
      }
    })
  }
  check('B1', '没有本机绝对路径 / 用户名泄漏', hits.length === 0, hits.length ? `\n      ${hits.join('\n      ')}` : `扫描 ${textFiles.length} 个文本文件`)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== C 运行时产物不应入库 ===')
{
  const runtime = allFiles.filter((f) => {
    const r = rel(f)
    return (
      /\.log$/.test(r) ||
      /(^|\/)\.realtime-server\.heartbeat$/.test(r) ||
      /(^|\/)model\.json$/.test(r) ||
      /intraday-\d{8}\.jsonl$/.test(r) ||
      /^rank20\//.test(r) ||
      /var[^/]*\//.test(r)
    )
  })
  check('C1', '日志/状态/产物文件不在待提交清单里', runtime.length === 0, runtime.length ? runtime.slice(0, 8).map(rel).join(', ') : '无')

  const gi = existsSync(join(ROOT, '.gitignore')) ? readFileSync(join(ROOT, '.gitignore'), 'utf8') : ''
  const need = ['node_modules', '.env', 'rank20', 'var', '*.log']
  const missing = need.filter((n) => !gi.includes(n))
  check('C2', '.gitignore 覆盖运行时产物与依赖目录', missing.length === 0, missing.length ? `缺：${missing.join(', ')}` : need.join(' / '))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== D 待提交清单（体积概览）===')
{
  const byDir = new Map()
  let total = 0
  const sizes = []
  for (const f of allFiles) {
    const r = rel(f)
    const top = r.includes('/') ? r.split('/')[0] : '(根目录)'
    const st = statSync(f)
    total += st.size
    sizes.push([r, st.size])
    const cur = byDir.get(top) ?? { n: 0, b: 0 }
    byDir.set(top, { n: cur.n + 1, b: cur.b + st.size })
  }
  sizes.sort((a, b) => b[1] - a[1])
  console.log(`  待提交 ${allFiles.length} 个文件，共 ${(total / 1024 / 1024).toFixed(2)} MB${SHOW_ALL ? '（含运行时数据）' : '（已排除 node_modules / rank20 数据 / var*）'}`)
  for (const [d, v] of [...byDir.entries()].sort((a, b) => b[1].b - a[1].b)) {
    console.log(`    ${d.padEnd(22)} ${String(v.n).padStart(5)} 个文件  ${(v.b / 1024).toFixed(0).padStart(6)} KB`)
  }
  console.log('  最大的 8 个文件：')
  for (const [r, b] of sizes.slice(0, 8)) console.log(`    ${(b / 1024).toFixed(0).padStart(6)} KB  ${r}`)

  const big = sizes.filter(([, b]) => b > 512 * 1024)
  check('D1', '没有 >512KB 的单文件（GitHub 友好）', big.length === 0, big.map(([r, b]) => `${r}(${(b / 1024).toFixed(0)}KB)`).join(', ') || '无')
  check('D2', '待提交体积 < 20MB', total < 20 * 1024 * 1024, `${(total / 1024 / 1024).toFixed(2)} MB`)
}

// ══════════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.pass).length
console.log(`\n=== 结果：${pass}/${results.length} 通过${pass === results.length ? '' : `，${results.length - pass} 失败`} ===`)
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.id} ${r.name}`)
process.exit(pass === results.length ? 0 : 1)
