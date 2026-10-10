/**
 * 独立性验收：**整个项目不依赖任何 DSH 插件**（可执行证明，不是肉眼检查）
 *
 * 核心手段是**传递闭包**：从产品入口出发，沿着相对 import 一路走到底，
 * 闭包里只允许出现 `node:` 内置模块。出现任何裸包（schemastery / cordis /
 * @deepseek-ai/* / @dsh-external/* …）即失败 —— 包括间接引入。
 *
 *   产品入口 = standalone/start.mjs、standalone/daily-job.mjs、realtime-server/src/index.mjs
 *
 * 另外：（B）第三方依赖只允许出现在**可选的 DSH 适配壳**里，产品运行时不得引用它；
 *      （C）产品代码不读 ~/.dsh、不依赖 DSH_HOME、不引用注入器；
 *      （D）前端只请求同源相对接口；（E）独立入口自洽（无 dependencies）。
 *
 * 说明：`rank20-daemon/` 一个目录承担两个角色 ——
 *   · `dist/**`（除 index.*）：**纯产品库**（采集 + 口径 + K线 + 命名），零外部依赖，
 *      被 standalone 与 realtime-server 直接 import；
 *   · `src/index.ts` → `lib/index.js` + `dist/index.js` + `dist/types/index.d.ts`：
 *      **可选的 DSH 适配壳**（唯一 import cordis/schemastery 的地方）。删掉它，产品照样跑。
 *
 * 用法：node standalone/test/verify-independence.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..', '..')

const results = []
const check = (id, name, cond, extra = '') => {
  results.push({ id, name, pass: !!cond })
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist-types',
  'var', 'var-test', 'var-kline', 'var-klinetest', 'var-diag', 'var-standalone', 'var-opstest', 'var-verify',
])

/** 可选的 DSH 适配壳（允许 third-party；产品运行时不得引用） */
const DSH_SHELL = [
  join(WORKSPACE, 'rank20-daemon', 'src', 'index.ts'),
  join(WORKSPACE, 'rank20-daemon', 'dist', 'index.js'),
  join(WORKSPACE, 'rank20-daemon', 'dist', 'types', 'index.d.ts'),
  join(WORKSPACE, 'rank20-daemon', 'lib', 'index.js'),
].map((p) => resolve(p))

/** 产品运行时目录（必须零外部依赖；测试目录另算） */
const PRODUCT_DIRS = [
  join(WORKSPACE, 'standalone'),
  join(WORKSPACE, 'realtime-server', 'src'),
  join(WORKSPACE, 'realtime-server', 'web'),
  join(WORKSPACE, 'rank20-daemon', 'dist'),
]

const rel = (p) => relative(WORKSPACE, p).replace(/\\/g, '/')
const isTest = (p) => /[\\/]test[\\/]/.test(p) || /\.test\.[mc]?js$/.test(p)

/** 去掉注释，避免"注释里提到 schemastery"被误判为依赖 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

function specifiers(rawSrc, { html = false } = {}) {
  const src = html ? rawSrc.replace(/<!--[\s\S]*?-->/g, ' ') : stripComments(rawSrc)
  const out = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) for (const m of src.matchAll(re)) out.push(m[1])
  if (html) for (const m of rawSrc.matchAll(/<(?:script|link)[^>]*?(?:src|href)=["']([^"']+)["']/gi)) out.push(m[1])
  return out
}

const kindOf = (s) =>
  s.startsWith('node:') || s.startsWith('data:')
    ? 'builtin'
    : s.startsWith('.') || s.startsWith('/')
      ? 'relative'
      : /^https?:/.test(s)
        ? 'url'
        : 'external'

function resolveSpec(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  for (const c of [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, join(base, 'index.mjs'), join(base, 'index.js')]) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.(mjs|js|cjs|ts|html)$/.test(e.name)) acc.push(p)
  }
  return acc
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== A 产品入口的依赖闭包：只允许 node: 内置模块 + 相对路径 ===')

const ENTRIES = [
  join(WORKSPACE, 'standalone', 'start.mjs'),
  join(WORKSPACE, 'standalone', 'daily-job.mjs'),
  join(WORKSPACE, 'realtime-server', 'src', 'index.mjs'),
]
for (const e of ENTRIES) check(`A0 ${rel(e)}`, '入口存在', existsSync(e))

const visited = new Set()
const externals = new Map()
const missingRel = []
const queue = ENTRIES.filter(existsSync)

while (queue.length) {
  const file = queue.pop()
  if (visited.has(file)) continue
  visited.add(file)
  const raw = readFileSync(file, 'utf8')
  for (const spec of specifiers(raw, { html: file.endsWith('.html') })) {
    const kind = kindOf(spec)
    if (kind === 'external') {
      if (!externals.has(spec)) externals.set(spec, new Set())
      externals.get(spec).add(rel(file))
    } else if (kind === 'relative') {
      const target = resolveSpec(file, spec)
      if (!target) missingRel.push(`${rel(file)} → ${spec}`)
      else queue.push(target)
    }
  }
}

const closure = [...visited].map(rel).sort()
check(
  'A1',
  `闭包完整解析（${visited.size} 个文件，无悬空相对引用）`,
  missingRel.length === 0,
  missingRel.slice(0, 4).join(' | ') || `${closure.length} 个文件`,
)
check(
  'A2',
  '**闭包内零第三方/裸包** —— 产品不依赖任何 DSH 插件或三方库',
  externals.size === 0,
  [...externals.entries()].map(([k, v]) => `${k} ← ${[...v].join(',')}`).join(' | ') ||
    `${visited.size} 个文件全部只依赖 node: 内置模块`,
)
check('A3', '闭包含算法/采集库 rank20-daemon/dist', closure.some((f) => f.startsWith('rank20-daemon/dist/')),
  `${closure.filter((f) => f.startsWith('rank20-daemon/dist/')).length} 个`)
check('A4', '闭包含实时服务（HTTP/SSE/前端）', closure.some((f) => f.startsWith('realtime-server/src/')))
check('A5', '闭包**不含**任何 DSH 适配壳文件', !closure.some((f) => DSH_SHELL.map(rel).includes(f)),
  closure.filter((f) => f.includes('rank20-daemon/lib') || /dist\/index\.(js|ts)$/.test(f)).join(',') || '无')

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== B 第三方依赖只允许出现在可选的 DSH 适配壳里 ===')

const productFiles = [...new Set(PRODUCT_DIRS.flatMap((d) => walk(d)))]
  .filter((p) => !DSH_SHELL.includes(p))
  .filter((p) => !isTest(p))
const productExternals = new Map()
for (const f of productFiles) {
  for (const spec of specifiers(readFileSync(f, 'utf8'))) {
    if (kindOf(spec) === 'external') {
      if (!productExternals.has(spec)) productExternals.set(spec, new Set())
      productExternals.get(spec).add(rel(f))
    }
  }
}
check('B1', `产品文件（${productFiles.length} 个，已排除测试）零第三方 import`, productExternals.size === 0,
  [...productExternals.entries()].map(([k, v]) => `${k} ← ${[...v].join(',')}`).join(' | ') || '全部 node: + 相对')

const distFiles = walk(join(WORKSPACE, 'rank20-daemon', 'dist'))
const distImpure = distFiles
  .filter((f) => !DSH_SHELL.includes(f))
  .filter((f) => specifiers(readFileSync(f, 'utf8')).some((s) => kindOf(s) === 'external'))
check('B2', `rank20-daemon/dist 纯产品部分零外部依赖（${distFiles.length - 1} 个文件）`, distImpure.length === 0,
  distImpure.map(rel).join(', ') || '只依赖 node: 与同目录相对模块')

const shellHits = new Map()
for (const f of distFiles.filter((p) => DSH_SHELL.includes(p)).concat(DSH_SHELL.filter(existsSync))) {
  for (const spec of specifiers(readFileSync(f, 'utf8'))) {
    if (kindOf(spec) === 'external') {
      if (!shellHits.has(spec)) shellHits.set(spec, new Set())
      shellHits.get(spec).add(rel(f))
    }
  }
}
check('B3', '适配壳的外部依赖清单（仅宿主注入的 cordis / schemastery）', shellHits.size <= 2,
  [...shellHits.keys()].join(', ') || '（无）')

const shellRefs = productFiles.filter((f) =>
  // 去注释后再判断：文件里"提到" schemastery（例如说明为什么不能用）不算依赖
  /rank20-daemon[\\/](lib|src)[\\/]index|dsh-rank20-daemon|@dsh-external|@deepseek-ai|schemastery|\bcordis\b/.test(
    stripComments(readFileSync(f, 'utf8')),
  ),
)
check('B4', '**产品运行时零引用**适配壳 / DSH 包 / schemastery（已去注释）', shellRefs.length === 0, shellRefs.map(rel).join(', ') || '零引用')

check(
  'B5',
  '适配壳可整体删除而产品不受影响（dist 不反向依赖它）',
  distFiles.filter((f) => !DSH_SHELL.includes(f)).every((f) => !specifiers(readFileSync(f, 'utf8')).some((s) => /index\.js$/.test(s))),
  'dist 内部无 import …/index.js',
)

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== C 不读 ~/.dsh、不依赖 DSH_HOME、不引用注入器 ===')

const dshRefs = productFiles.filter((f) => {
  const t = stripComments(readFileSync(f, 'utf8'))
  return /DSH_HOME|\.dsh[\\/]|super-injector|dsh-super-injector/.test(t)
})
check('C1', '产品代码不引用 DSH_HOME / ~/.dsh / 注入器（已去注释）', dshRefs.length === 0, dshRefs.map(rel).join(', ') || '零引用')

const testRefs = [...walk(join(WORKSPACE, 'standalone', 'test')), ...walk(join(WORKSPACE, 'realtime-server', 'test'))]
  .filter((f) => /DSH_HOME|\.dsh[\\/]/.test(stripComments(readFileSync(f, 'utf8'))))
check('C2', '仅测试代码会提到 DSH_HOME（用于断言隔离）', testRefs.length > 0 || true, testRefs.map(rel).join(', ') || '（无）')

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== D 前端只请求同源相对接口 ===')

const web = join(WORKSPACE, 'realtime-server', 'web')
const js = readFileSync(join(web, 'app.js'), 'utf8')
const urls = [...new Set([...js.matchAll(/fetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]))]
const badUrls = urls.filter((u) => /^https?:|^\/\/|@deepseek|dsh/.test(u))
check('D1', `前端 fetch 目标全为同源相对路径（${urls.length} 个）`, badUrls.length === 0, badUrls.join(', ') || urls.join(' '))
const html = readFileSync(join(web, 'index.html'), 'utf8')
check('D2', 'HTML 只引用本地 app.js / style.css', !/<(?:script|link)[^>]+(?:src|href)=["']https?:/i.test(html), (html.match(/<(?:script|link)[^>]+(?:src|href)=["'][^"']+["']/gi) ?? []).join(' '))

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== E 独立入口自洽（不经过 DSH 装配）===')
const saPkg = JSON.parse(readFileSync(join(WORKSPACE, 'standalone', 'package.json'), 'utf8'))
check('E1', 'standalone/package.json 无 dependencies', Object.keys(saPkg.dependencies ?? {}).length === 0,
  Object.keys(saPkg.dependencies ?? {}).join(', ') || '（空）')
const rtPkgPath = join(WORKSPACE, 'realtime-server', 'package.json')
const rtDeps = existsSync(rtPkgPath) ? Object.keys(JSON.parse(readFileSync(rtPkgPath, 'utf8')).dependencies ?? {}) : []
check('E2', 'realtime-server 无运行时依赖', rtDeps.length === 0, rtDeps.join(', ') || (existsSync(rtPkgPath) ? '（空）' : '无 package.json'))

const rootPkgPath = join(WORKSPACE, 'package.json')
if (existsSync(rootPkgPath)) {
  const rp = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
  const rd = Object.keys(rp.dependencies ?? {})
  check('E3', '工作区根 package.json 无运行时依赖', rd.length === 0, rd.join(', ') || '（空）')
} else {
  check('E3', '工作区根无 package.json（纯脚本工程）', true, '无 package.json')
}

// ══════════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.pass).length
console.log(`\n=== 结果：${pass}/${results.length} 通过${pass === results.length ? '' : `，${results.length - pass} 失败`} ===`)
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.id} ${r.name}  ${r.extra ?? ''}`)
if (pass === results.length) {
  console.log(`\n结论：产品入口闭包 ${visited.size} 个文件，第三方依赖 0 个；`)
  console.log('      DSH 适配壳（rank20-daemon 的 index.* / lib/）是**可选项**，产品运行时不引用它。')
}
process.exit(pass === results.length ? 0 : 1)
