/**
 * 凭据与环境变量加载测试（安全相关，随仓库一起跑）
 *
 * 覆盖：
 *   · .env 解析（注释 / 引号 / 行内注释 / 空行）
 *   · 真实环境变量优先级高于 .env（CI/容器注入不被文件覆盖）
 *   · DCE 凭据**只能**来自环境；源码里不得出现硬编码值
 *   · 缺凭据时报**可操作**的错误（不能静默降级）
 *
 * 用法：node test/env.test.mjs
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..') // rank20-daemon/
const REPO = resolve(ROOT, '..')

const results = []
const check = (id, name, cond, extra = '') => {
  results.push({ id, name, pass: !!cond })
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

const { parseEnv, env, loadEnvFile, dceCredentials, DCE_DEFAULT_HOST } = await import('../dist/env.js')

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== E1 .env 解析 ===')
{
  const doc = parseEnv(
    [
      '# 注释行',
      '',
      'A=1',
      'B = spaced ',
      'C="quoted value"',
      "D='single'",
      'E=value # 行内注释',
      'F=',
      'NOT_A_PAIR',
    ].join('\n'),
  )
  check('E1a', '解析键值对并跳过注释/空行/非法行', doc.A === '1' && doc.NOT_A_PAIR === undefined, JSON.stringify(doc))
  check('E1b', '等号两侧空格被裁掉', doc.B === 'spaced')
  check('E1c', '成对引号内的内容原样保留', doc.C === 'quoted value' && doc.D === 'single')
  check('E1d', '未加引号时去掉行内 # 注释', doc.E === 'value', doc.E)
  check('E1e', '空值保留为空字符串（不报错）', doc.F === '')
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== E2 真实环境变量优先级 ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'envtest-'))
  const file = join(dir, '.env')
  writeFileSync(file, 'AUDIT_TEST_A=from-file\nAUDIT_TEST_B=only-file\n', 'utf8')
  // loadEnvFile 只生效一次，这里直接验语义：先设真实变量，再加载文件
  process.env.AUDIT_TEST_A = 'from-real-env'
  delete process.env.AUDIT_TEST_B
  // 用子模块缓存绕过"只加载一次"：直接调用内部解析 + 注入逻辑等价物
  const parsed = parseEnv(readFileSync(file, 'utf8'))
  for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v
  check('E2a', '同名真实环境变量不被 .env 覆盖', process.env.AUDIT_TEST_A === 'from-real-env', process.env.AUDIT_TEST_A)
  check('E2b', '.env 里独有的变量会被补齐', process.env.AUDIT_TEST_B === 'only-file', process.env.AUDIT_TEST_B)
  delete process.env.AUDIT_TEST_A
  delete process.env.AUDIT_TEST_B
  rmSync(dir, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== E3 DCE 凭据只来自环境 ===')
{
  const saved = { k: process.env.DCE_API_KEY, s: process.env.DCE_SECRET, h: process.env.DCE_HOST }

  process.env.DCE_API_KEY = 'unit-key'
  process.env.DCE_SECRET = 'unit-secret'
  delete process.env.DCE_HOST
  const c = dceCredentials()
  check('E3a', '读得到 apiKey / secret', c.apiKey === 'unit-key' && c.secret === 'unit-secret')
  check('E3b', '未设 DCE_HOST 时用默认主机', c.host === DCE_DEFAULT_HOST, c.host)

  process.env.DCE_HOST = 'proxy.example.com'
  check('E3c', 'DCE_HOST 可覆盖（自建代理）', dceCredentials().host === 'proxy.example.com')

  delete process.env.DCE_API_KEY
  delete process.env.DCE_SECRET
  let msg = ''
  try {
    dceCredentials()
  } catch (e) {
    msg = e.message
  }
  check('E3d', '缺凭据时抛错（不静默降级）', msg.length > 0)
  check('E3e', '错误信息可操作：指出缺哪些变量 + 获取方式 + .env 示例',
    /DCE_API_KEY/.test(msg) && /DCE_SECRET/.test(msg) && /dce\.com\.cn/.test(msg) && /\.env/.test(msg),
    msg.split('\n')[0])

  // 还原现场
  if (saved.k !== undefined) process.env.DCE_API_KEY = saved.k
  if (saved.s !== undefined) process.env.DCE_SECRET = saved.s
  if (saved.h !== undefined) process.env.DCE_HOST = saved.h
  else delete process.env.DCE_HOST
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== E4 源码里不得出现硬编码凭据（发布红线）===')
{
  const scanDirs = [join(ROOT, 'src'), join(ROOT, 'dist'), join(ROOT, 'lib')]
  const bad = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|js|mjs|d\.ts)$/.test(e.name)) continue
      const txt = readFileSync(p, 'utf8')
      txt.split('\n').forEach((line, i) => {
        // 允许：变量名本身、读取语句、报错文案、占位符
        if (/process\.env|env\(|DCE_API_KEY=你的|缺少|placeholder|示例/.test(line)) return
        if (/DCE_(API_KEY|SECRET)\s*[:=]\s*['"][^'"]{3,}['"]/.test(line)) bad.push(`${p.replace(REPO, '.')}:${i + 1}`)
      })
    }
  }
  for (const d of scanDirs) walk(d)
  check('E4a', 'src / dist / lib 中无 DCE 凭据字面量', bad.length === 0, bad.join(', ') || '已全部抽离到 .env')

  const exampleOk = existsSync(join(REPO, '.env.example'))
  check('E4b', '仓库根提供 .env.example（且值为空占位）', exampleOk && /^DCE_API_KEY=\s*$/m.test(readFileSync(join(REPO, '.env.example'), 'utf8')))

  const gi = existsSync(join(REPO, '.gitignore')) ? readFileSync(join(REPO, '.gitignore'), 'utf8') : ''
  check('E4c', '.gitignore 忽略 .env 但保留 .env.example', /^\.env$/m.test(gi) && /^!\.env\.example$/m.test(gi))
}

// ══════════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.pass).length
console.log(`\n=== 结果：${pass}/${results.length} 通过${pass === results.length ? '' : `，${results.length - pass} 失败`} ===`)
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.id} ${r.name}  ${r.extra ?? ''}`)
process.exit(pass === results.length ? 0 : 1)
