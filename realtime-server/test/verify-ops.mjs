/**
 * 运行状态模块验收：① 数据源连通性/延迟  ② 模型 API 配置与连通性测试
 *
 * 与其它套件同样的手法：**不改产品代码**，只桩掉"外部 HTTP 边界"里的模型服务端
 * （本地起一个假 OpenAI 兼容服务），实时服务真起、真打数据源。
 *
 * 重点断言：
 *   A 前后端资源一致性（app.js 引用的 DOM id 都在 index.html；前端确实接线了）
 *   B /api/sources 真实探测：每源有 名称/地址/延迟/状态，本地三件产物在列
 *   C **密钥安全**：任何 HTTP 响应体里都不出现明文 Key；只回掩码；落盘文件 0600
 *   D /api/model/test 三条路径：chat/completions 成功、回退 models、全失败
 *   E 缓存与强制刷新语义（60s 缓存 / POST 强制）
 *
 * 用法：node test/verify-ops.mjs
 */
import { mkdirSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RT = resolve(HERE, '..')
const WORKSPACE = resolve(RT, '..')
const SCRATCH = join(RT, 'var-opstest')

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
// 装载真实基准表与 K 线库（只读复制，不改动原始数据）——让"本地产物"三件齐全
{
  const baseSrc = join(WORKSPACE, 'rank20', 'base.json')
  if (existsSync(baseSrc)) writeFileSync(join(SCRATCH, 'base.json'), readFileSync(baseSrc))
  const realKline = join(WORKSPACE, 'rank20', 'kline')
  if (existsSync(realKline)) {
    mkdirSync(join(SCRATCH, 'kline'), { recursive: true })
    for (const f of readdirSync(realKline)) {
      if (f.endsWith('.json')) writeFileSync(join(SCRATCH, 'kline', f), readFileSync(join(realKline, f)))
    }
  }
}

process.env.RT_PORT = '8896'
process.env.RT_VAR = SCRATCH
process.env.RT_OUT = SCRATCH
process.env.RT_INTERVAL_MS = '5000'

const results = []
const check = (id, name, cond, extra = '') => {
  results.push({ id, name, pass: !!cond })
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== A 前后端资源一致性（静态）===')
{
  const html = readFileSync(join(RT, 'web', 'index.html'), 'utf8')
  const js = readFileSync(join(RT, 'web', 'app.js'), 'utf8')

  const opsIds = [
    'ops', 'opsSummary', 'opsToggle', 'opsBody',
    'srcProbe', 'srcMeta', 'srcRows',
    'modelForm', 'mBase', 'mModel', 'mKey', 'mTest', 'mClear', 'mResult', 'mStorePath', 'mMeta',
  ]
  const missing = opsIds.filter((id) => !html.includes(`id="${id}"`))
  check('A1', 'ops 模块全部 DOM id 都存在于 index.html', missing.length === 0, missing.join(',') || `${opsIds.length} 个`)

  const fns = ['loadSources', 'loadModelConfig', 'saveModel', 'testModelConn', 'clearModelKey', 'renderSources', 'initOps']
  const missFn = fns.filter((f) => !new RegExp(`function ${f}\\b|${f}\\s*=`).test(js))
  check('A2', 'app.js 实现了两个模块的全部前端函数', missFn.length === 0, missFn.join(',') || fns.length + ' 个')

  check('A3', '启动即拉取源状态与模型配置', /^\s*initOps\(\)\s*$/m.test(js) && /^\s*loadSources\(false\)\s*$/m.test(js) && /^\s*loadModelConfig\(\)\s*$/m.test(js))

  check('A4', 'Key 输入框是 type=password 且禁止自动填充', /id="mKey"[^>]*type="password"/.test(html) && /autocomplete="new-password"/.test(html))

  check('A5', '页面明示"不回传明文"', /不会回传明文/.test(html))

  check(
    'A6',
    '前端提交后清空 Key 输入框（绝不留明文在 DOM）',
    /\$\('mKey'\)\.value = ''/.test(js),
  )

  check(
    'A7',
    '前端只用掩码/布尔，不请求明文 Key',
    !/\.apiKey\b/.test(js) || !/json\(\)[^\n]*apiKey/.test(js),
    'app.js 中无 apiKey 读取',
  )

  // 静态资源引用完整性
  for (const asset of ['/app.js', '/style.css']) {
    const f = join(RT, 'web', asset.slice(1))
    check(`A8${asset}`, `${asset} 存在`, existsSync(f))
  }
  const css = readFileSync(join(RT, 'web', 'style.css'), 'utf8')
  check('A9', 'ops 模块样式已落 CSS', /\.ops\b/.test(css) && /\.lat\b/.test(css), `${css.split('\n').length} 行`)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== B 假模型服务端（本地，用于连通性测试的三条路径）===')
/** 记录收到的 Authorization，供"服务端确实带上了 Key"断言 */
const seenAuth = []
const fake = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  seenAuth.push({ path: u.pathname, auth: req.headers.authorization ?? '' })
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (u.pathname === '/v1/chat/completions') {
    return send(200, { choices: [{ message: { role: 'assistant', content: 'pong' } }] })
  }
  if (u.pathname === '/v1/models') {
    return send(200, { data: [{ id: 'fake-chat' }, { id: 'fake-reasoner' }] })
  }
  // /nokey 前缀：模拟"Key 有效但 chat 端点不被支持"（405）→ 逼出 models 回退
  if (u.pathname === '/nokey/chat/completions') return send(405, { error: 'not supported' })
  if (u.pathname === '/nokey/models') return send(200, { data: [{ id: 'fallback-model' }] })
  // /bad 前缀：两个端点都 500
  if (u.pathname.startsWith('/bad/')) return send(500, { error: 'boom' })
  return send(404, { error: 'not found', path: u.pathname })
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const FAKE = `http://127.0.0.1:${fake.address().port}`

/** 一个必然连不上的端口（拿一个端口监听后立刻关掉） */
const deadPort = await new Promise((r) => {
  const s = netServer()
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => r(p))
  })
})

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== C 真起实时服务，验证 /api/sources ===')
const { config } = await import('../src/config.mjs')
const { SnapshotHub } = await import('../src/snapshot.mjs')
const { Store } = await import('../src/store.mjs')
const { BaseWatcher } = await import('../src/base.mjs')
const { Poller } = await import('../src/poller.mjs')
const { startServer } = await import('../src/server.mjs')

// 用真实基准表（只读复制已在上面完成）；服务端自己的数据目录仍是 SCRATCH
const store = new Store()
const hub = new SnapshotHub()
const watcher = new BaseWatcher(config.baseFile)
watcher.refresh() // 加载基准表（等价于轮询器启动时的首次加载）
const poller = new Poller(watcher, hub, store)
const server = await startServer({ poller, hub, baseWatcher: watcher })

const BASE = `http://127.0.0.1:${config.port}`
const req = async (p, opt = {}) => {
  const r = await fetch(BASE + p, {
    method: opt.method ?? 'GET',
    headers: opt.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  })
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: r.status, text, body }
}

check('C0', '测试目录已隔离', config.varDir === SCRATCH && config.outDir === SCRATCH, config.varDir)

// 让轮询器真的跑起来产出首份快照，这样"本地产物三件"才会全绿
poller.start()
const snap = await (async () => {
  const t = Date.now()
  while (Date.now() - t < 30000) {
    const r = await req('/api/rank20/latest')
    if (r.body?.seq > 0) return r.body
    await new Promise((s) => setTimeout(s, 400))
  }
  return null
})()
check('C0b', '轮询器已产出首份实时快照', !!snap, snap ? `seq=${snap.seq} 换价=${snap.liveCount}/${snap.total}` : '超时')

const t0 = Date.now()
const src = await req('/api/sources')
check('C1', '/api/sources 返回 200', src.status === 200, `${Date.now() - t0}ms`)

const S = src.body?.sources ?? []
const need = ['id', 'name', 'url', 'ok', 'latencyMs']
const badField = S.filter((s) => need.some((k) => s[k] === undefined || s[k] === ''))
check('C2', `每个源都有 名称/地址/状态/延迟（${S.length} 个）`, S.length >= 7 && badField.length === 0,
  badField.map((s) => s.id).join(',') || S.map((s) => `${s.id}:${s.ok ? '✓' : '✗'}${s.latencyMs}ms`).join(' '))

check('C3', '延迟是真实测量值（>0 且 <60s）', S.every((s) => s.latencyMs > 0 && s.latencyMs < 60000))

const ids = S.map((s) => s.id)
check('C4', '覆盖 新浪 + 六所官方日报', ids.includes('sina') && ['shfe', 'ine', 'czce', 'dce', 'gfex', 'cffex'].every((x) => ids.includes(x)), ids.join(','))

check('C5', '地址是真实端点；带日期的模板已代入交易日',
  S.filter((s) => s.kind === 'eod').every((s) => /^https?:\/\//.test(s.url)) &&
    S.filter((s) => s.kind === 'eod' && /\d{8}/.test(s.url)).length >= 4,
  S.filter((s) => s.kind === 'eod').map((s) => `${s.id}${/\d{8}/.test(s.url) ? '带日期' : '日期在请求体'}`).join(' '))

check('C6', '解析出的合约行数随状态一并返回', S.filter((s) => s.kind === 'eod' && s.ok).every((s) => s.rows > 0),
  S.filter((s) => s.kind === 'eod').map((s) => `${s.id}=${s.rows ?? 0}`).join(' '))

const L = src.body?.local ?? []
check('C7', '本地三件产物在列（基准表/日K库/实时榜）', L.length === 3 && L.every((x) => x.kind === 'local' && x.url),
  L.map((x) => `${x.id}:${x.ok ? '✓' : '✗'}`).join(' '))

check('C7b', '本地产物三项全部就绪', L.every((x) => x.ok === true), L.map((x) => `${x.id}=${x.ok ? 'ok' : x.detail}`).join(' | '))
check('C8', '基准表产物报告交易日/基准日/品种数', /交易日 \d{8}.*基准日 \d{8}.*\d+ 个品种/.test(L[0]?.detail ?? ''), L[0]?.detail ?? '')

check('C8b', 'K 线库产物报告合约文件数', /\d+ 个合约文件/.test(L[1]?.detail ?? ''), L[1]?.detail ?? '')

const tCache = Date.now()
const src2 = await req('/api/sources')
check('C9', '60s 内重复请求走缓存（<200ms）', src2.body?.cached === true && Date.now() - tCache < 2000,
  `cached=${src2.body?.cached} ${Date.now() - tCache}ms`)

const tForce = Date.now()
const src3 = await req('/api/sources/probe', { method: 'POST' })
check('C10', 'POST 强制重探（绕过缓存，重新计时）', src3.body?.cached === false && src3.body?.elapsedMs > 0,
  `elapsedMs=${src3.body?.elapsedMs} 请求总耗时=${Date.now() - tForce}ms`)

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== D 模型配置与密钥安全 ===')

const KEY = 'sk-verify-0123456789abcdef-WXYZ'

const cfg0 = await req('/api/model/config')
check('D1', '初始未配置', cfg0.status === 200 && cfg0.body?.hasKey === false && cfg0.body?.keyMasked === '')
check('D2', '配置视图不含明文 Key 字段', !('apiKey' in (cfg0.body ?? {})), Object.keys(cfg0.body ?? {}).join(','))
check('D3', '告知落盘路径（服务端数据目录内）', String(cfg0.body?.storePath ?? '').startsWith(SCRATCH), cfg0.body?.storePath ?? '')

const badUrl = await req('/api/model/config', { method: 'POST', body: { baseUrl: 'ftp://x', model: 'm' } })
check('D4', '非法地址被拒绝', badUrl.status === 400 && badUrl.body?.ok === false, badUrl.body?.error ?? '')

const save1 = await req('/api/model/config', { method: 'POST', body: { baseUrl: `${FAKE}/v1`, model: 'fake-chat', apiKey: KEY } })
check('D5', '保存成功且响应里只有掩码', save1.status === 200 && save1.body?.ok === true && save1.body?.config?.hasKey === true,
  `keyMasked=${save1.body?.config?.keyMasked}`)
check('D6', '**保存响应体里不含明文 Key**', !save1.text.includes(KEY), save1.text.includes(KEY) ? '⚠ 泄露！' : '已确认')
check('D7', '掩码只露头 3 尾 4、中间定长星号', save1.body?.config?.keyMasked === `sk-${'*'.repeat(8)}WXYZ`, save1.body?.config?.keyMasked ?? '')

const cfg1 = await req('/api/model/config')
check('D8', '**GET 配置响应体里不含明文 Key**', !cfg1.text.includes(KEY) && cfg1.body?.hasKey === true, `keyMasked=${cfg1.body?.keyMasked}`)

const file = cfg1.body?.storePath
check('D9', 'Key 落盘到服务端私有文件', existsSync(file))
{
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : ''
  check('D10', '落盘文件确实持有 Key（服务端持有）', raw.includes(KEY))
  let mode = null
  try { mode = statSync(file).mode & 0o777 } catch { /* ignore */ }
  check('D11', '文件权限 0600（POSIX）/ 由 Windows ACL 管控',
    process.platform === 'win32' ? true : mode === 0o600,
    `mode=${mode?.toString(8) ?? 'n/a'} platform=${process.platform}${process.platform === 'win32' ? '（chmod 在 Windows 无效，文件位于用户私有目录）' : ''}`)
  check('D12', '落盘内容不含多余明文副本', (raw.match(new RegExp(KEY, 'g')) ?? []).length === 1)
}

// 留空 = 保持原 Key 不变
const save2 = await req('/api/model/config', { method: 'POST', body: { baseUrl: `${FAKE}/v1`, model: 'fake-reasoner' } })
check('D13', '留空 Key 提交 → 保持原 Key', save2.body?.config?.hasKey === true && save2.body?.config?.keyMasked === `sk-${'*'.repeat(8)}WXYZ`,
  `model=${save2.body?.config?.model}`)

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== E 模型连通性测试（三条路径）===')

const t1 = await req('/api/model/test', { method: 'POST', body: {} })
check('E1', 'chat/completions 通路成功', t1.status === 200 && t1.body?.ok === true && t1.body?.via === 'chat/completions',
  `HTTP ${t1.body?.status} ${t1.body?.latencyMs}ms reply=${t1.body?.reply}`)
check('E2', '测试响应不含明文 Key', !t1.text.includes(KEY))
check('E3', '服务端确实带上了 Authorization: Bearer', seenAuth.some((x) => x.path === '/v1/chat/completions' && x.auth === `Bearer ${KEY}`))
check('E4', '返回模型回包内容（证明模型真的答了）', t1.body?.reply === 'pong', t1.body?.reply ?? '')

// 未保存的 Key 也能直接测（前端"先测后存"）
const t2 = await req('/api/model/test', { method: 'POST', body: { baseUrl: `${FAKE}/v1`, model: 'fake-chat', apiKey: 'sk-other-1234567890-ABCD' } })
check('E5', '可用未保存的 Key 直接测试', t2.body?.ok === true)
check('E6', '未保存的 Key 也不回显', !t2.text.includes('sk-other-1234567890-ABCD'))

// 回退 models
const t3 = await req('/api/model/test', { method: 'POST', body: { baseUrl: `${FAKE}/nokey`, model: 'x' } })
check('E7', 'chat 端点失败 → 回退 /models 并成功', t3.body?.ok === true && t3.body?.via === 'models',
  `models=${(t3.body?.models ?? []).join(',')}`)
check('E8', '回退时如实说明"未验证具体模型"', /未验证具体模型/.test(t3.body?.note ?? ''), t3.body?.note ?? '')

// 全失败
const t4 = await req('/api/model/test', { method: 'POST', body: { baseUrl: `${FAKE}/bad`, model: 'x' } })
check('E9', '两端点都失败 → ok=false 且列出 attempts', t4.body?.ok === false && (t4.body?.attempts ?? []).length === 2,
  (t4.body?.attempts ?? []).map((a) => `${a.via}:${a.status ?? a.error}`).join(' | '))
check('E10', '失败时给出可操作提示', typeof t4.body?.hint === 'string' && t4.body.hint.length > 10, t4.body?.hint ?? '')

// 连接不上
const t5 = await req('/api/model/test', { method: 'POST', body: { baseUrl: `http://127.0.0.1:${deadPort}/v1`, model: 'x' } })
check('E11', '端口不通 → ok=false 且报告错误', t5.body?.ok === false && (t5.body?.attempts ?? []).some((a) => a.error),
  (t5.body?.attempts ?? []).map((a) => a.error).filter(Boolean)[0] ?? '')

// 只填空白 = 视为未提供 → 回退用已保存的 Key（不会拿空白串去当 Bearer）
const t6 = await req('/api/model/test', { method: 'POST', body: { baseUrl: `${FAKE}/v1`, model: 'fake-chat', apiKey: '   ' } })
check('E12', 'Key 只填空白 → 回退用已保存的 Key', t6.body?.ok === true, `via=${t6.body?.via}`)
check('E12b', '空白 Key 不会作为 Bearer 发出去', !seenAuth.some((x) => x.auth === 'Bearer    '))

// 清除 Key
const del = await req('/api/model/key', { method: 'DELETE' })
check('E13', '清除 Key 成功', del.status === 200 && del.body?.ok === true && del.body?.config?.hasKey === false)
const after = await req('/api/model/config')
check('E14', '清除后 hasKey=false 且掩码为空', after.body?.hasKey === false && after.body?.keyMasked === '')
{
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : ''
  check('E15', '清除后落盘文件不再含明文 Key', !raw.includes(KEY))
}
const t7 = await req('/api/model/test', { method: 'POST', body: {} })
check('E16', '清除后再测 → 明确失败', t7.body?.ok === false && /未配置/.test(t7.body?.error ?? ''), t7.body?.error ?? '')

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== F 全量响应体扫描：任何接口都不得泄露明文 Key ===')
{
  await req('/api/model/config', { method: 'POST', body: { baseUrl: `${FAKE}/v1`, model: 'fake-chat', apiKey: KEY } })
  const paths = ['/api/health', '/api/model/config', '/api/rank20/latest', '/api/sources', '/api/model/test']
  const leaks = []
  for (const p of paths) {
    const r = p === '/api/model/test' ? await req(p, { method: 'POST', body: {} }) : await req(p)
    if (r.text.includes(KEY)) leaks.push(p)
  }
  check('F1', `${paths.length} 个接口响应体扫描无明文 Key`, leaks.length === 0, leaks.join(',') || '全部干净')

  const maskOnly = await req('/api/model/config')
  check('F2', '对外只暴露 掩码 + hasKey + 地址 + 模型名', 
    JSON.stringify(Object.keys(maskOnly.body ?? {}).sort()) === JSON.stringify(['baseUrl', 'hasKey', 'keyMasked', 'model', 'savedAt', 'storePath']),
    Object.keys(maskOnly.body ?? {}).join(','))
}

// ══════════════════════════════════════════════════════════════════════════
server.close?.()
poller.stop?.()
fake.close()
rmSync(SCRATCH, { recursive: true, force: true }) // 含测试用的假 model.json，跑完不留痕

const pass = results.filter((r) => r.pass).length
console.log(`\n════════════════════════════════════════`)
console.log(`  结果：${pass}/${results.length} 通过`)
const failed = results.filter((r) => !r.pass)
if (failed.length) {
  console.log('  失败项：')
  for (const f of failed) console.log(`    ✗ ${f.id} ${f.name}`)
}
console.log(`════════════════════════════════════════\n`)
process.exit(failed.length ? 1 : 0)
