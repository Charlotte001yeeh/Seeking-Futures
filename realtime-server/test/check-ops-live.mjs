/**
 * 运行状态模块 · 对着**正在运行的实例**做只读体检（用浏览器真正会拿到的资源）
 * 用法：node test/check-ops-live.mjs [port]
 */
const PORT = Number(process.argv[2] ?? 8899)
const B = `http://127.0.0.1:${PORT}`
const g = async (p, o) => {
  const r = await fetch(B + p, o)
  return { s: r.status, t: await r.text(), h: r.headers }
}

const html = await g('/')
const js = await g('/app.js')
const css = await g('/style.css')

console.log(`── 静态资源（${B}）──`)
console.log(`  index.html ${html.s} ${html.t.length}B  运行状态段=${/id="ops"/.test(html.t)} 折叠钮=${/id="opsToggle"/.test(html.t)} 默认折叠=${/class="ops collapsed"/.test(html.t)}`)
console.log(`  app.js     ${js.s} ${js.t.length}B  loadSources=${/function loadSources/.test(js.t)} testModelConn=${/function testModelConn/.test(js.t)} 滚动策略=${/function syncScrollPolicy/.test(js.t)}`)
console.log(`  style.css  ${css.s} ${css.t.length}B  .ops=${/\.ops \{/.test(css.t)} opsBody内部滚动=${/\.opsBody \{[^}]*overflow: (auto|scroll)/.test(css.t) ? '有(旧)' : '无'}`)

// 布局契约：双榜一屏看全、榜内零滚动条
const layout = {
  '--chromeH': /--chromeH:\s*(\d+)px/.exec(css.t)?.[1],
  '--rowH': /--rowH:\s*([^;]+);/.exec(css.t)?.[1]?.trim(),
  'tableWrap 无内部滚动': /\.tableWrap \{[^}]*overflow:\s*visible/.test(css.t),
  '数据行绑定 --rowH': /\.grid tbody tr:not\(\.expandRow\) \{ height: var\(--rowH\)/.test(css.t),
  'body 默认不滚动': /^body \{[\s\S]*?overflow:\s*hidden/m.test(css.t),
  '展开时放开整页滚动': /body\.expanded, body\.ops-open \{ overflow-y: auto/.test(css.t),
}
console.log('\n── 布局契约（涨/跌榜各 20 行一眼看全）──')
for (const [k, v] of Object.entries(layout)) console.log(`  ${v === false || v === undefined ? '✗' : '✓'} ${k}${typeof v === 'string' ? ' = ' + v : ''}`)

const s = JSON.parse((await g('/api/sources')).t)
console.log(`\n── 数据源（tradeDate ${s.tradeDate}，${s.okCount}/${s.total} 可用，${s.elapsedMs}ms，cached=${s.cached}）──`)
for (const x of s.sources) {
  console.log(`  ${x.ok ? '✓' : '✗'} ${x.name.padEnd(14)} ${String(x.latencyMs).padStart(5)}ms  ${x.detail ?? x.error ?? ''}`)
  console.log(`      ${x.url}`)
}
console.log('\n── 本地产物 ──')
for (const x of s.local) console.log(`  ${x.ok ? '✓' : '✗'} ${x.name.padEnd(22)} ${x.detail}`)
console.log(`\n── 模型 ──\n  ${JSON.stringify(s.model)}`)
console.log(`  /api/model/config → ${(await g('/api/model/config')).t}`)

const probe = await g('/api/sources/probe', { method: 'POST' })
const pj = JSON.parse(probe.t)
console.log(`\n── 强制重探（POST）── ${pj.cached === false ? '已绕过缓存' : '⚠ 仍走缓存'} elapsedMs=${pj.elapsedMs}`)
console.log(`  合计 ${pj.okCount}/${pj.total} 可用：` + pj.sources.map((x) => `${x.id}${x.ok ? '✓' : '✗'}${x.latencyMs}ms`).join(' '))

// 未配置 Key 时的失败路径也必须"如实报告"
const t = JSON.parse((await g('/api/model/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).t)
console.log(`\n── 模型连通性测试（当前未配置）── ok=${t.ok} error=${t.error ?? ''} hint=${(t.hint ?? '').slice(0, 40)}`)
