/**
 * K 线 + 硬逻辑 端到端验收（**不改产品代码**）
 *
 * 与 diag-realtime.mjs 同样的手法：只桩掉外部 HTTP 边界 + 平移系统时钟，
 * 其余全部是生产代码。目的：
 *   A 前后端资源一致性（app.js 引用的 DOM id 必须都存在于 index.html）
 *   B /api/variety/:v/kline 返回真实 K 线，且**官方根优先**（官方日不得是 sina/live）
 *   C 实时行情能滚动"正在形成的那一根"（新交易日 → 追加；官方根不被覆盖）
 *   D /api/variety/:v/logic 返回带真实证据的规则推导，并明确标注模型未接入
 *   E 前端已改为"行内就地展开"（无 drawer、有 expandRow/panelNav 结构）
 *
 * 用法：node test/verify-kline.mjs
 */
import { mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RT = resolve(HERE, '..')
const WORKSPACE = resolve(RT, '..')
const SCRATCH = join(RT, 'var-klinetest')

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
  const css = readFileSync(join(RT, 'web', 'style.css'), 'utf8')
  const ids = [...js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1])
  // 展开面板内的元素由 JS 动态生成（不在 index.html 里）
  const dynamic = new Set([
    'expandPanel', 'kchart', 'chartWrap', 'chartTip', 'chartLegend', 'kclear', 'kmeta', 'barReadout',
    'kzoomIn', 'kzoomOut', 'kreset',
  ])
  const missing = [...new Set(ids)].filter((id) => !dynamic.has(id) && !html.includes(`id="${id}"`))
  check('A1', 'app.js 引用的静态 DOM id 都存在于 index.html', missing.length === 0, missing.join(',') || `${new Set(ids).size} 个 id`)
  check('A2', '已移除右侧抽屉（改为行内展开）', !html.includes('class="drawer"') && js.includes('buildExpandRow'))
  check('A3', '面板导航条：4 个板块，硬逻辑与题材龙头已拆开',
    js.includes('panelNav') && js.includes("['kline', '日K图']") && js.includes("['logic', '硬逻辑']") &&
    js.includes("['theme', '题材龙头']") && js.includes("['data', '数据溯源']"))
  check('A3b', '面板高度自适应（四板块等高，无内部滚动条）',
    js.includes('fitPanelHeight') && js.includes('.panelBody.measure') === false &&
    /\.panelBody \{[^}]*overflow:\s*visible/.test(css) && !/\.panelBody \{[^}]*overflow-y:\s*auto/.test(css))
  check('A3b11', '拖动平移为亚根精度（不取整）',
    js.includes('vp.startF') && js.includes('drag.off + (ev.clientX - drag.x) / geo.step'))
  check('A3b12', '拖动状态在模块级（不被每帧重绘重置）',
    /const drag = \{ active: false/.test(js) && js.includes('if (cv.dataset.bound') && js.includes('bindChart(cv)'))
  check('A3b2', '表格固定布局（防展开行撑宽整表 → 板块尺寸不一致的根因）',
    /table\s*\{[^}]*table-layout:\s*fixed/.test(css))
  check('A3b3', '面板横向溢出内部消化（不撑宽表格）', /\.panelBody \{[^}]*overflow-x:\s*hidden/.test(css))
  check('A3b4', 'grid 子项 min-width:0（防方向栏等内容撑破框）',
    css.includes('minmax(0, 220px)') && /\.logicCard\s*\{[^}]*min-width:\s*0/.test(css))
  // ⚠️ 回归守卫：绝不能再出现无作用域的 `tbody td { white-space: nowrap }`
  //    —— 它会命中展开行 <td colspan=10>，而 white-space 可继承 → 面板内所有文本不换行 → 撑破卡片压邻居
  check('A3b5', 'nowrap 已限定到数据行（不再命中展开行）',
    /\.grid tbody tr:not\(\.expandRow\) > td \{[^}]*white-space:\s*nowrap/.test(css) &&
    !/(^|\n)\s*tbody td \{[^}]*white-space:\s*nowrap/.test(css))
  check('A3b6', '展开行内部显式恢复换行',
    /\.grid tbody tr\.expandRow > td,\s*\.panel,\s*\.panelBody,\s*\.panelBody \* \{\s*white-space:\s*normal/.test(css))
  check('A3b7', '面板内表格固定布局 + 允许断行',
    /\.panel table \{[^}]*table-layout:\s*fixed/.test(css) && /\.evTable th, \.kvTable td \{[^}]*overflow-wrap:\s*anywhere/.test(css))
  check('A3b8', '读数网格/图表元信息不溢出（min-width:0 + 省略号）',
    /\.roGrid span \{[^}]*text-overflow:\s*ellipsis/.test(css) && /#kmeta \{[^}]*text-overflow:\s*ellipsis/.test(css))
  check('A3b9', '主表行规则全部限定 .grid（不污染面板内层表格）',
    !/(^|\n)\s*tbody (tr|td)\b/.test(css) && (css.match(/\.grid tbody/g) ?? []).length >= 6)
  check('A3b10', '主表已加 class="grid"', (html.match(/<table class="grid">/g) ?? []).length === 2)
  check('A3c', 'K线图含时间横轴刻度', js.includes('时间横轴') && js.includes('axTop + 17'))
  check('A3d', '点击K线固定读数到下方固定面板', js.includes('updateReadout') && js.includes('barReadout') && js.includes('pickedDate'))
  check('A3e', '十字光标整图重绘（不留白色虚线残影）',
    js.includes('整图重绘') && js.includes('requestAnimationFrame'))
  check('A3f', 'K线缩放：放大 / 缩小 / 还原 三个按钮', js.includes('kzoomIn') && js.includes('kzoomOut') && js.includes('kreset'))
  check('A3g', '缩放支持滚轮 + 拖动平移', js.includes("addEventListener('wheel'") && js.includes("addEventListener('pointerdown'") && js.includes('clampOffset'))
  check('A4', 'Canvas 蜡烛图实现存在（零图表库）',
    js.includes('getContext(\'2d\')') && !/from ['"]https?:/.test(js) && !js.includes('chart.js'))
  check('A5', '点击行触发就地展开', js.includes('toggleExpand') && js.includes('insertBefore(state.expandEl'))
  check('A6', '样式含展开行/导航条/图表规则',
    css.includes('tr.expandRow') && css.includes('.panelNav') && css.includes('.chartWrap canvas'))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== B/C/D 端到端（桩外部 HTTP + 平移时钟，跑生产代码）===')
const RealDate = Date
// 把"现在"平移到**最近一个工作日的 14:00**（既在工作日、又在交易时段内），
// 这样 inTradingWindow() 为真，轮询器才会真跑；Date.now() 仍按真实时间推进。
const _now = new RealDate()
const _target = new RealDate(_now)
_target.setDate(_target.getDate() - (_now.getDay() === 0 ? 2 : _now.getDay() === 6 ? 1 : 0))
_target.setHours(14, 0, 0, 0)
const SHIFT = _target.getTime() - _now.getTime()
class ShiftedDate extends RealDate {
  constructor(...a) { a.length === 0 ? super(RealDate.now() + SHIFT) : super(...a) }
  static now() { return RealDate.now() }
}
globalThis.Date = ShiftedDate
console.log(`     时钟平移后 = ${new Date().toLocaleString('zh-CN')}`)

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
// K 线是**真实数据**（官方日报 + 新浪历史），复制进隔离目录只读使用。
// 新克隆的仓库还没有 rank20/（.gitignore 忽略运行时数据）→ 如实 SKIP 而不是假失败。
const REAL_KLINE = join(WORKSPACE, 'rank20', 'kline')
const hasKline = existsSync(REAL_KLINE) && readdirSync(REAL_KLINE).some((f) => f.endsWith('.json'))
if (!hasKline) {
  console.log('\n  ⏭ SKIP：尚未生成日K线数据（rank20/kline/ 不存在）')
  console.log('     这些用例验证的是"真实 K 线 + 官方优先合成 + 实时滚动"，需要真数据。')
  console.log('     先跑一次每日任务即可：node standalone/daily-job.mjs（约 2–3 分钟，需 .env 里的 DCE 凭据）\n')
  console.log('=== 结果：0/0 通过（SKIP：缺 rank20/kline 数据）===')
  process.exit(0)
}
mkdirSync(join(SCRATCH, 'kline'), { recursive: true })
for (const f of readdirSync(REAL_KLINE)) {
  if (f.endsWith('.json')) writeFileSync(join(SCRATCH, 'kline', f), readFileSync(join(REAL_KLINE, f)))
}
console.log(`     已装载真实 K 线 ${readdirSync(join(SCRATCH, 'kline')).length} 个文件`)

process.env.RT_PORT = '8894'
process.env.RT_VAR = SCRATCH
process.env.RT_OUT = SCRATCH
process.env.RT_BASE = join(WORKSPACE, 'rank20', 'base.json')
process.env.RT_INTERVAL_MS = '1500'

const { sinaSymbol } = await import('../../rank20-daemon/dist/realtime.js')
const baseDoc = JSON.parse(readFileSync(process.env.RT_BASE, 'utf8'))
const bySym = new Map()
for (const r of baseDoc.rows) {
  const s = sinaSymbol(r.contract)
  if (s) bySym.set(s, r)
}

// 桩：行情源。tradeDay 必须**晚于日K最后一根**才能验证"追加形成中那根"。
// ⚠️ 不能写死日期：K 线是真实数据，会随每日任务前移（曾经写死 2026-09-21，
//    等到 kline 里已有 09-22 官方根时就变成"liveD < last.d → 忽略"，测试假失败）。
//    这里从**真实 K 线的最后一根**推出下一个交易日，测试与数据进展解耦。
const rbRow = baseDoc.rows.find((r) => r.variety === 'rb') ?? baseDoc.rows[0]
const rbDoc = JSON.parse(readFileSync(join(SCRATCH, 'kline', `${rbRow.contract}.json`), 'utf8'))
const lastBarD = String(rbDoc.bars.at(-1).d)
const nextD = (() => {
  const d = new Date(Number(lastBarD.slice(0, 4)), Number(lastBarD.slice(4, 6)) - 1, Number(lastBarD.slice(6, 8)))
  do d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
})()
const LIVE_DAY = nextD
const LIVE_TRADE_DAY = `${LIVE_DAY.slice(0, 4)}-${LIVE_DAY.slice(4, 6)}-${LIVE_DAY.slice(6, 8)}`
console.log(`     K线末根 ${lastBarD} → 桩行情交易日 ${LIVE_TRADE_DAY}（用于验证追加形成中那根）`)
let tick = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  if (!u.includes('hq.sinajs.cn')) return realFetch(url, opts)
  tick++
  const list = u.split('/list=')[1] ?? ''
  const hhmmss = new RealDate().toTimeString().slice(0, 8).replace(/:/g, '')
  const lines = []
  for (const sym of list.split(',').filter(Boolean)) {
    const row = bySym.get(sym)
    const seed = row ? row.close : 1000
    const price = Math.round(seed * (1 + tick * 0.0004) * 100) / 100
    const f = new Array(44).fill('0')
    f[0] = row ? row.name : sym
    f[1] = hhmmss
    f[2] = String(Math.round(price * 0.998 * 100) / 100) // 今开
    f[3] = String(Math.round(price * 1.002 * 100) / 100) // 最高
    f[4] = String(Math.round(price * 0.997 * 100) / 100) // 最低
    f[6] = String(price)
    f[10] = String(Math.round(price * 0.995 * 100) / 100)
    f[13] = String(100000 + tick * 9)
    f[14] = String(500000 + tick * 17)
    f[17] = LIVE_TRADE_DAY
    f[18] = '1'
    lines.push(`var hq_str_${sym}="${f.join(',')}";`)
  }
  return new Response(lines.join('\n'), { status: 200, headers: { 'content-type': 'application/javascript' } })
}

const { main } = await import('../src/index.mjs')
const rt = await main({ installSignalHandlers: false })
const B = `http://127.0.0.1:${process.env.RT_PORT}`

// 等第一轮实时快照
let snap = null
for (let i = 0; i < 40 && !snap; i++) {
  await new Promise((s) => setTimeout(s, 500))
  const r = await fetch(`${B}/api/rank20/latest`)
  if (r.status === 200) {
    const j = await r.json()
    if (j.liveCount > 0) snap = j
  }
}
check('B0', '实时快照已产生（换价 > 0）', !!snap, snap ? `换价 ${snap.liveCount}/${snap.total}` : '超时')

const K = await (await fetch(`${B}/api/variety/rb/kline?days=120`)).json()
console.log(`     rb kline: ${K.bars?.length} 根  来源=${JSON.stringify(K.sourceBreakdown)}  官方起=${K.officialFrom} liveBarDate=${K.liveBarDate}`)

check('B1', '返回真实 K 线（≥100 根）', K.bars?.length >= 100, `${K.bars?.length} 根`)
check('B2', '每根都带来源标记 src', K.bars?.length > 0 && K.bars.every((b) => ['eod', 'eod_settle_as_close', 'sina', 'live'].includes(b.src)))
const eodBars = K.bars.filter((b) => b.src.startsWith('eod'))
const lastEod = eodBars.at(-1)?.d
const inWindow = K.bars.filter((b) => b.d >= K.officialFrom && b.d <= lastEod)
check('B3', '官方覆盖窗口内**全部**是官方根（官方优先，第三方不得挤入）',
  inWindow.length > 0 && inWindow.every((b) => b.src.startsWith('eod')),
  `窗口 ${K.officialFrom}~${lastEod} 共 ${inWindow.length} 根，全为官方`)
check('B4', '官方根含成交额（来自官方日报，第三方没有）',
  K.bars.filter((b) => b.src === 'eod' && b.to > 0).length > 0,
  `${K.bars.filter((b) => b.to > 0).length} 根带 to`)
check('B5', 'OHLC 关系自洽（l ≤ min(o,c) ≤ max(o,c) ≤ h）',
  K.bars?.length > 0 && K.bars.every((b) => b.l <= Math.min(b.o, b.c) + 1e-6 && Math.max(b.o, b.c) <= b.h + 1e-6))

// C：实时滚动形成中的那根
check('C1', `实时交易日（${LIVE_TRADE_DAY}）触发**追加**形成中的那根`,
  K.liveBarDate === LIVE_DAY && K.bars.at(-1).d === LIVE_DAY,
  `liveBarDate=${K.liveBarDate}`)
check('C2', '形成中那根标记为 live 且 OHLC 来自实时行情',
  K.bars?.length > 0 && K.bars.at(-1).src === 'live' && K.bars.at(-1).h > 0 && K.bars.at(-1).l > 0)
check('C3', '官方根未被实时值篡改（历史最后一根仍是官方）',
  K.bars?.length > 1 && K.bars.filter((b) => b.d < LIVE_DAY).at(-1).src.startsWith('eod'))

// D：硬逻辑
const L = await (await fetch(`${B}/api/variety/rb/logic`)).json()
check('D1', '硬逻辑返回方向与板块', ['long', 'short', 'neutral'].includes(L.direction) && !!L.sector, `${L.directionCN} / ${L.sector}`)
check('D2', '明确标注为规则推导且模型未接入（不冒充模型）',
  L.generatedBy === 'rules-v1' && L.modelConnected === false)
check('D3', '硬逻辑条目均含真实数值', Array.isArray(L.hardLogic) && L.hardLogic.length >= 3, `${L.hardLogic?.length} 条`)
check('D4', '每条证据带 source 与数值',
  Array.isArray(L.evidence) && L.evidence.length >= 4 && L.evidence.every((e) => e.source && e.value !== undefined),
  `${L.evidence?.length} 条证据`)
check('D5', '含失效条件', Array.isArray(L.invalidation) && L.invalidation.length >= 1)
check('D6', '题材/龙头/确认日三项字段齐备',
  'sector' in L && 'leader' in L && 'confirmDate' in L, `龙头=${L.leader} 确认日=${L.confirmDate ?? '无'}`)
check('D7', '证据来源标注区分官方/实时/推导',
  new Set(L.evidence.map((e) => e.source)).size >= 2, [...new Set(L.evidence.map((e) => e.source))].join(','))

// 覆盖多个品种
let ok = 0, fail = []
for (const v of ['sc', 'lc', 'ma', 'ppF', 'if']) {
  const r = await fetch(`${B}/api/variety/${v}/kline?days=60`)
  const j = await r.json()
  if (r.status === 200 && j.bars?.length > 0) ok++
  else fail.push(`${v}:${r.status}/${j.bars?.length ?? 'x'}`)
}
check('B6', '多品种覆盖（含月均价 F 与金融）', ok === 5, fail.join(',') || '5/5')

await rt.close()
globalThis.fetch = realFetch
rmSync(SCRATCH, { recursive: true, force: true })

const pass = results.filter((r) => r.pass).length
const failN = results.length - pass
console.log(`\n=== 结果：${pass}/${results.length} 通过${failN ? `，${failN} 失败` : ''} ===`)
if (failN) for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.id} ${r.name}`)
process.exit(failN ? 1 : 0)
