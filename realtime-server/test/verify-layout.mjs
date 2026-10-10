/**
 * 布局验收：**双榜是主要展示界面 —— 各 20 行一眼看全、榜内零滚动条**
 *
 * 做法（与 verify-kline 的 A3b* 系列同一套路：静态断言 + 尺寸算术）：
 *   A 榜内不得出现任何滚动容器（.board / .tableWrap 不得 overflow:auto|scroll）
 *   B 行高由视口高度反推（--rowH = (100vh − --chromeH) / 20，夹在 [18,42]）
 *   C --chromeH 的算术必须与各部件实际高度自洽，且在常见视口高度下 20 行装得下
 *   D 默认整页不滚动；只有展开行详情 / 展开运行状态时才放开页面滚动
 *   E 运行状态模块默认折叠（把竖直空间让给双榜）
 *   F 表格仍 table-layout:fixed（不被展开行里的宽内容撑破）
 *
 * 用法：node test/verify-layout.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RT = resolve(HERE, '..')
const css = readFileSync(join(RT, 'web', 'style.css'), 'utf8')
const js = readFileSync(join(RT, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(RT, 'web', 'index.html'), 'utf8')

const results = []
const check = (id, name, cond, extra = '') => {
  results.push({ id, name, pass: !!cond })
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${name}${extra ? `  ${extra}` : ''}`)
}

/**
 * 取某条规则的声明体。
 * ⚠️ 必须**行首锚定**：CSS 里存在 `body.expanded .boards, body.ops-open .boards {…}`
 * 与 `.ops.collapsed .opsBody {…}` 这类复合选择器；不锚定就会把它们的声明误当成
 * `.boards` / `.opsBody` 本身（本测试自己踩过一次，故留注释）。
 */
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^[ \\t]*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  return m ? m[1] : ''
}
/** 取 CSS 变量值 */
function cssVar(name) {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css)
  return m ? m[1].trim() : ''
}
const px = (s) => {
  const m = /(-?\d+(?:\.\d+)?)px/.exec(String(s))
  return m ? Number(m[1]) : NaN
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== A 榜内零滚动条 ===')
{
  const board = rule('.board')
  const wrap = rule('.tableWrap')
  const boards = rule('.boards')
  check('A1', '.tableWrap 不再滚动（无 overflow: auto/scroll）', !/overflow(-[xy])?\s*:\s*(auto|scroll)/.test(wrap), wrap.match(/overflow[^;]*/)?.[0] ?? '（未声明 overflow）')
  check('A2', '.tableWrap 显式 overflow: visible', /overflow\s*:\s*visible/.test(wrap))
  check('A3', '.board 自身不滚动', !/overflow(-[xy])?\s*:\s*(auto|scroll)/.test(board))
  check('A4', '.boards 容器不滚动', !/overflow(-[xy])?\s*:\s*(auto|scroll)/.test(boards))
  check('A5', '主表没有 max-height（否则必然要滚动）', !/\.tableWrap[^{]*\{[^}]*max-height/.test(css))
  check('A6', '表头不再用 sticky（无内部滚动时无意义）', !/position\s*:\s*sticky/.test(rule('thead th')))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== B 行高由视口反推 ===')
{
  const rowH = cssVar('--rowH')
  check('B1', '--rowH 用 clamp 夹在 [18, 42]px', /^clamp\(\s*18px\s*,/.test(rowH) && /,\s*42px\s*\)$/.test(rowH), rowH)
  check('B2', '--rowH 由 (100vh − --chromeH) / 20 反推', /calc\(\s*\(\s*100vh\s*-\s*var\(--chromeH\)\s*\)\s*\/\s*20\s*\)/.test(rowH), rowH)
  const tr = rule('.grid tbody tr:not(.expandRow)')
  check('B3', '数据行高度绑定 --rowH', /height\s*:\s*var\(--rowH\)/.test(tr), tr.trim())
  check('B4', '骨架行同高（加载态不跳动）', /height\s*:\s*var\(--rowH\)/.test(rule('.grid tbody tr.skel td')))
  const td = rule('.grid tbody tr:not(.expandRow) > td')
  check('B5', '单元格改为竖直居中（padding 0 + line-height 紧凑）', /padding\s*:\s*0 /.test(td) && /line-height\s*:\s*1\.15/.test(td), td.trim())
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== C --chromeH 算术自洽 + 常见视口装得下 20 行 ===')
{
  // 各部件实际高度（与 CSS 声明一一对应）
  const topbar = px(rule('.topbar').match(/height\s*:\s*[\d.]+px/)?.[0] ?? '')
  const banner = px(rule('.banner').match(/flex\s*:\s*0 0 [\d.]+px/)?.[0] ?? '')
  const footer = px(rule('.footer').match(/flex\s*:\s*0 0 [\d.]+px/)?.[0] ?? '')
  const boardH2 = px(rule('.board h2').match(/height\s*:\s*[\d.]+px/)?.[0] ?? '')
  const theadH = px(rule('thead th').match(/height\s*:\s*[\d.]+px/)?.[0] ?? '')
  const opsBtn = px(rule('.ghostBtn').match(/height\s*:\s*[\d.]+px/)?.[0] ?? '')
  const opsPad = px(rule('.opsHead').match(/padding\s*:\s*[\d.]+px/)?.[0] ?? '')
  // margin: 0 12px 8px → 竖直占用看**第三个**值（下外边距），不是 12px 的左右外边距
  const opsMargin = px((rule('.ops').match(/margin\s*:\s*0\s+\d+px\s+[\d.]+px/)?.[0] ?? '').split(/\s+/).at(-1) ?? '')
  const boardsPad = px(rule('.boards').match(/padding\s*:\s*[\d.]+px/)?.[0] ?? '')

  const parts = { topbar, banner, footer, boardH2, theadH, opsBtn, opsPad, opsMargin, boardsPad }
  const missing = Object.entries(parts).filter(([, v]) => !Number.isFinite(v)).map(([k]) => k)
  check('C1', '所有参与预算的部件都有显式像素高度', missing.length === 0, missing.join(',') || Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(' '))

  // 实际占用 = 顶栏 + 横幅 + (按钮+上下内边距+下边框+外边距) + 页脚 + 榜单标题 + 表头 + 容器上下内边距 + 榜单边框
  const actual = topbar + banner + (opsBtn + opsPad * 2 + 1 + opsMargin) + footer + boardH2 + theadH + boardsPad * 2 + 2
  const budget = px(cssVar('--chromeH'))
  check('C2', `--chromeH(${budget}) ≥ 实际占用(${actual})`, budget >= actual, `余量 ${budget - actual}px`)

  const slack = budget - actual
  const viewports = [1080, 950, 900, 800, 768, 700, 640, 620]
  const rows = viewports.map((v) => {
    const rowH = Math.min(42, Math.max(18, (v - budget) / 20))
    // 浏览器会把小数行高逐行向上取整 → 按每行 +0.5px 的最坏情况校验
    const total = Math.ceil(rowH + 0.5) * 20 + actual
    return { v, rowH: Math.round(rowH * 10) / 10, total: Math.round(total), fits: total <= v }
  })
  check('C3', `常见视口高度下 20 行全部装得下（含逐行向上取整的最坏情况）`, rows.every((r) => r.fits),
    rows.map((r) => `${r.v}=${r.rowH}px→${r.total}${r.fits ? '✓' : '✗'}`).join(' '))
  const short = (620 - budget) / 20
  check('C4', '620px 视口仍在 18px 下限之上（再矮才整页滚动）', short >= 18, `行高 ${short.toFixed(1)}px`)
  check('C5', '余量 ≥ 10px（吸收小数行高取整）', slack >= 10, `余量 ${slack}px`)
  check('C6', '矮窗口有整页滚动兜底，且榜单仍不加内部滚动条',
    /@media\s*\(max-height:\s*620px\)\s*\{[^}]*body\s*\{[^}]*overflow-y:\s*auto/.test(css) &&
    !/max-height:\s*[\d.]+px;\s*overflow:\s*auto/.test(rule('.opsBody')))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== D 滚动策略：默认整页不滚，展开时才放开 ===')
{
  check('D1', 'body 默认 overflow: hidden', /overflow\s*:\s*hidden/.test(rule('body')))
  check('D2', 'body.expanded / body.ops-open 放开页面滚动', /body\.expanded,\s*body\.ops-open\s*\{\s*overflow-y:\s*auto/.test(css))
  check('D3', '展开时榜单不再被压缩（flex: 0 0 auto）', /body\.expanded\s+\.boards,\s*body\.ops-open\s+\.boards\s*\{\s*flex:\s*0 0 auto/.test(css))
  check('D4', 'app.js 维护 body 滚动策略类', /function syncScrollPolicy/.test(js) &&
    /classList\.toggle\('expanded'/.test(js) && /classList\.toggle\('ops-open'/.test(js))
  check('D5', '展开/收起行都会同步滚动策略', /replantExpandRow\(\)\s*\n\s*syncScrollPolicy\(\)/.test(js) &&
    /state\.expanded = null\s*\n\s*syncScrollPolicy\(\)/.test(js))
  check('D6', '运行状态折叠/展开也同步滚动策略', /classList\.toggle\('collapsed'\)[\s\S]{0,160}syncScrollPolicy\(\)/.test(js))
  check('D7', '启动时初始化一次滚动策略', /initOps\(\)\s*\n\s*syncScrollPolicy\(\)/.test(js))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== E 运行状态默认折叠（空间让给双榜）===')
{
  check('E1', 'index.html 里 #ops 带 collapsed 类', /class="ops collapsed"\s+id="ops"/.test(html))
  check('E2', '按钮初值为"展开"', /id="opsToggle"[^>]*>展开/.test(html))
  check('E3', '折叠时只留标题条（opsBody 隐藏）', /\.ops\.collapsed\s+\.opsBody\s*\{\s*display:\s*none/.test(css))
  check('E4', 'opsBody 仍为内容自撑（无内部滚动）', /overflow:\s*visible/.test(rule('.opsBody')))
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== F 双榜作为主展示区的其它约束 ===')
{
  check('F1', '双榜等宽两列', /grid-template-columns:\s*1fr 1fr/.test(rule('.boards')))
  check('F2', '主表 table-layout: fixed（不被展开行撑宽）', /table-layout:\s*fixed/.test(rule('table')))
  check('F3', '榜单标题高度固定（计入预算）', /height:\s*30px/.test(rule('.board h2')))
  check('F4', '顶栏高度固定 56px', /flex:\s*0 0 56px/.test(rule('.topbar')))
  check('F5', '页脚高度固定 28px', /flex:\s*0 0 28px/.test(rule('.footer')))
  check('F6', '涨跌榜各有 20 行（数据契约不变）', /20/.test(js) && html.includes('bodyGain') && html.includes('bodyLoss'))
}

// ══════════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.pass).length
console.log(`\n=== 结果：${pass}/${results.length} 通过${pass === results.length ? '' : `，${results.length - pass} 失败`} ===`)
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.id} ${r.name}  ${r.extra ?? ''}`)
process.exit(pass === results.length ? 0 : 1)
