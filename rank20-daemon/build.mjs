/**
 * 构建脚本（跨平台，不依赖 bash）。
 *
 *   1) tsc          → dist/    逐模块产物 + 类型声明（供 run-now.mjs / test-run.mjs 等脚本使用）
 *   2) esbuild      → lib/index.js
 *                   **单文件**插件入口。宿主热重载只换入口 URL，相对 import 会命中 Node 的 ESM
 *                   模块缓存；打成单文件后不存在相对 import，任何改动都能被热重载正确加载。
 *
 * 用法：node build.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
/**
 * 可选的**兜底**工具链位置（例如开发机上 DSH 检出里的 pnpm store）。
 * 留空即只用本仓库自带的 typescript / esbuild —— 本项目**不依赖**任何外部检出。
 */
const DSH = process.env.DSH_CHECKOUT || ''

const firstExisting = (paths) => paths.find((p) => p && existsSync(p))

/**
 * 找 typescript 的 lib/tsc.js（直接 node 跑，绕开 .cmd 的 spawn 限制）。
 *
 * 查找顺序刻意把**本仓库自带**放在最前，DSH checkout 只作为开发机便利的兜底：
 * 构建工具链不是产品依赖，装了 typescript 的机器上不需要 DSH 也能构建。
 */
function findTscJs() {
  const local = [
    process.env.TSC_JS,
    process.env.DSH_TSC_JS,
    join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'),
    join(root, '..', 'node_modules', 'typescript', 'lib', 'tsc.js'),
  ].filter(Boolean)
  for (const p of local) if (existsSync(p)) return p

  // 兜底：可选的 DSH checkout（仅当显式设置 DSH_CHECKOUT 时才查；未设置则跳过）
  if (!DSH) return undefined
  const pnpm = join(DSH, 'node_modules', '.pnpm')
  if (!existsSync(pnpm)) return undefined
  for (const d of readdirSync(pnpm)) {
    if (!d.startsWith('typescript@')) continue
    const p = join(pnpm, d, 'node_modules', 'typescript', 'lib', 'tsc.js')
    if (existsSync(p)) return p
  }
  return undefined
}

const TSC_JS = findTscJs()

/** 同上：本仓库自带 esbuild 优先（插件内或仓库根 node_modules）；DSH checkout 只在显式指定时兜底 */
const ESBUILD = firstExisting([
  process.env.ESBUILD,
  process.env.DSH_ESBUILD,
  join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
  join(root, '..', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
  join(root, 'node_modules', '.bin', 'esbuild.exe'),
  join(root, '..', 'node_modules', '.bin', 'esbuild.exe'),
  ...(DSH
    ? ['0.28.1', '0.25.12', '0.21.5'].map((v) =>
        join(DSH, 'node_modules', '.pnpm', `@esbuild+win32-x64@${v}`, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
      )
    : []),
])

if (!TSC_JS) throw new Error('找不到 typescript/lib/tsc.js：在本仓库装 typescript（npm i -D typescript），或设置 TSC_JS=<path>')
if (!ESBUILD) throw new Error('找不到 esbuild：在本仓库装 esbuild（npm i -D esbuild），或设置 ESBUILD=<path>')

const run = (label, cmd, args) => {
  console.log(`\n=== ${label} ===`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) {
    throw new Error(`${label} 失败（exit ${r.status}）${r.error ? `: ${r.error.message}` : ''}`)
  }
}

run('tsc → dist/', process.execPath, [TSC_JS, '-p', 'tsconfig.json'])

rmSync(join(root, 'lib'), { recursive: true, force: true })
mkdirSync(join(root, 'lib'), { recursive: true })

run('esbuild → lib/index.js（单文件）', ESBUILD, [
  'src/index.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--target=node20',
  '--charset=utf8',
  '--outfile=lib/index.js',
  '--external:cordis',
  '--external:schemastery',
  '--external:@deepseek-ai/cordis',
  '--legal-comments=none',
  '--log-level=warning',
])

console.log('\n✓ 构建完成：lib/index.js（宿主入口）+ dist/（脚本用模块与类型）')
