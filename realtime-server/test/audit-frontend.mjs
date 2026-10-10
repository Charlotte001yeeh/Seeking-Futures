/**
 * 前端静态自检（不改产品代码）：DOM id 完整性 + class 名是否有样式 + 死变量残留
 * 用法：node test/audit-frontend.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RT = resolve(HERE, '..')
const html = readFileSync(join(RT, 'web', 'index.html'), 'utf8')
const js = readFileSync(join(RT, 'web', 'app.js'), 'utf8')
const css = readFileSync(join(RT, 'web', 'style.css'), 'utf8')

// ① app.js 里 $('x') 引用的 id 必须存在于 index.html（展开面板内部由 JS 动态生成）
const dynamic = new Set([
  'expandPanel', 'kchart', 'chartWrap', 'chartTip', 'chartLegend', 'kclear', 'kmeta',
  'barReadout', 'kzoomIn', 'kzoomOut', 'kreset',
])
const ids = [...new Set([...js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]))]
const missIds = ids.filter((i) => !dynamic.has(i) && !html.includes(`id="${i}"`))
console.log(`① DOM id：引用 ${ids.length} 个，缺失 ${missIds.length} 个 ${missIds.join(',') || '✓'}`)

// ② app.js 里内联的 class 名（静态模板串）必须能在 CSS / HTML 里找到
const used = new Set()
for (const m of js.matchAll(/class="([^"$]+)"/g)) for (const c of m[1].split(/\s+/)) if (c) used.add(c)
const cls2 = [...used].filter((c) => !css.includes(`.${c}`) && !html.includes(`class="${c}`) && !html.includes(` ${c}`))
console.log(`② class：内联 ${used.size} 个，CSS 未定义 ${cls2.length} 个 ${cls2.join(',') || '✓'}`)
console.log(`   ${[...used].sort().join(' ')}`)

// ③ 死变量：:root 里定义但全文再未出现的自定义属性
const defined = [...css.matchAll(/^\s*(--[a-z0-9-]+):/gim)].map((m) => m[1])
const dead = [...new Set(defined)].filter((v) => (css.match(new RegExp(`var\\(${v}[,\\)]`, 'g')) ?? []).length === 0)
console.log(`③ CSS 变量：定义 ${new Set(defined).size} 个，未被 var() 使用 ${dead.length} 个 ${dead.join(',') || '✓'}`)

// ④ 运行状态模块的两块内容必须在页面里（用户需求 D-ops ①②）
const need = [
  ['① 数据源地址/连通性/延迟', /id="srcRows"/.test(html) && /id="srcProbe"/.test(html) && /<th[^>]*>地址<\/th>/.test(html) && /<th[^>]*>延迟<\/th>/.test(html)],
  ['② 模型 API 输入框', /id="mBase"/.test(html) && /id="mModel"/.test(html) && /id="mKey"[^>]*type="password"/.test(html)],
  ['② 可测试连通性', /id="mTest"/.test(html) && /function testModelConn/.test(js)],
  ['② Key 不明文回显', /不会回传明文/.test(html) && /mKey'\)\.value = ''/.test(js)],
  ['位置在涨跌榜下方', html.indexOf('id="boardLoss"') < html.indexOf('id="ops"')],
  ['无内部滚动条（默认）', /\.opsBody\s*\{[^}]*overflow:\s*visible/.test(css)],
]
console.log('④ 需求对照：')
for (const [k, ok] of need) console.log(`   ${ok ? '✓' : '✗'} ${k}`)

const bad = missIds.length + cls2.length + need.filter(([, o]) => !o).length
console.log(`\n${bad === 0 ? '全部通过 ✓' : `发现 ${bad} 处问题 ✗`}`)
process.exit(bad ? 1 : 0)
