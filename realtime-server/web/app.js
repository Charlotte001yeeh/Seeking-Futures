/* ==========================================================================
   rank20 实时前端
   交互：点击榜单行 → 行下方就地展开导航条（日K图 / 硬逻辑 / 题材龙头 / 数据溯源）
   数据：全部真实；官方日报优先，第三方仅补齐；不做任何编造
   ========================================================================== */

const $ = (id) => document.getElementById(id)
const REDRAW_MS = 800

const state = {
  snap: null,
  pending: null,
  lastRedraw: 0,
  redrawTimer: null,
  rows: { gain: new Map(), loss: new Map() },
  activeBoard: 'gain',
  filter: '',
  es: null,
  retryMs: 1000,
  lastMsgAt: 0,
  expanded: null,
  expandEl: null,
}

// ── 工具 ─────────────────────────────────────────────────────────────────
const fmtNum = (v, d = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })
const fmtInt = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('zh-CN'))
const fmtPct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}`)
const dirOf = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '')
const arrow = (v) => (v > 0 ? '▲' : v < 0 ? '▼' : '')
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const dstr = (d) => (d && d.length === 8 ? `${d.slice(4, 6)}/${d.slice(6, 8)}` : d)
const dlong = (d) => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d)

// ── SSE ──────────────────────────────────────────────────────────────────
function connect() {
  if (state.es) state.es.close()
  const es = new EventSource('/events')
  state.es = es
  es.addEventListener('open', () => {
    state.retryMs = 1000
    setPill('connPill', 'ok', '已连接')
    fetch('/api/rank20/latest').then((r) => r.ok && r.json()).then((d) => d && d.seq && onSnapshot(d)).catch(() => {})
  })
  es.addEventListener('hello', (e) => {
    const h = JSON.parse(e.data)
    $('tradeDate').textContent = h.tradeDate || '—'
    $('baseDate').textContent = h.baseDate || '—'
  })
  es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)))
  es.addEventListener('heartbeat', () => { state.lastMsgAt = Date.now() })
  es.addEventListener('sourceHealth', (e) => {
    const h = JSON.parse(e.data)
    setPill('srcPill', h.state === 'ok' ? 'ok' : h.state === 'down' ? 'err' : 'warn', `源 ${h.source} ${h.state}`)
    if (h.state !== 'ok') showBanner('warn', `数据源降级（${h.source} / ${h.state}），可能沿用最近一次有效快照`)
    else hideBanner()
  })
  es.addEventListener('closed', (e) => {
    const d = JSON.parse(e.data)
    showBanner('info', `休市，显示 ${d.tradeDate} 收盘定稿榜（行情时间 ${d.quoteTime || '—'}）`)
  })
  es.addEventListener('error', () => {
    setPill('connPill', 'err', '重连中…')
    es.close()
    state.retryMs = Math.min(state.retryMs * 2, 8000)
    setTimeout(connect, state.retryMs)
  })
}

function setPill(id, s, text) {
  const el = $(id)
  el.dataset.state = s
  el.querySelector('span:last-child').textContent = text
}
let bannerKind = ''
function showBanner(kind, text) {
  const b = $('banner')
  b.hidden = false
  b.dataset.kind = kind
  b.textContent = text
  bannerKind = kind
}
function hideBanner() { if (bannerKind === 'warn' || bannerKind === 'info') $('banner').hidden = true }

// ── 快照 → 节流重绘 ──────────────────────────────────────────────────────
function onSnapshot(snap) {
  state.snap = snap
  state.lastMsgAt = Date.now()
  state.pending = snap
  if (state.redrawTimer) return
  const wait = Math.max(0, REDRAW_MS - (Date.now() - state.lastRedraw))
  state.redrawTimer = setTimeout(() => {
    state.redrawTimer = null
    state.lastRedraw = Date.now()
    if (state.pending) render(state.pending)
  }, wait)
}

function render(snap) {
  $('tradeDate').textContent = snap.tradeDate || '—'
  $('baseDate').textContent = snap.baseDate || '—'
  $('quoteTime').textContent = snap.quoteTime || '—'
  $('latency').textContent = snap.ageMs === null || snap.ageMs === undefined ? '—' : `~${(snap.ageMs / 1000).toFixed(1)}s`
  setPill('livePill', snap.liveCount === snap.total ? 'ok' : 'warn', `换价 ${snap.liveCount}/${snap.total}`)

  if (snap.liveCount === 0) showBanner('info', `休市：当前为日报口径（交易日 ${snap.tradeDate} · 基准日 ${snap.baseDate}），数值非实时`)
  else if (bannerKind === 'info') { $('banner').hidden = true; bannerKind = '' }
  if (snap.ageMs !== null && snap.ageMs > 30000) showBanner('warn', `数据可能陈旧：行情时间 ${snap.quoteTime || '—'}，相差 ${(snap.ageMs / 1000).toFixed(0)}s`)
  else if (bannerKind === 'warn') { $('banner').hidden = true; bannerKind = '' }

  $('gainCount').textContent = `${snap.gainers.length} 条`
  $('lossCount').textContent = `${snap.losers.length} 条`
  $('footStat').textContent = `seq ${snap.seq} · 服务器 ${new Date(snap.serverTime).toLocaleTimeString('zh-CN')}`

  paint('gain', snap.gainers, $('bodyGain'))
  paint('loss', snap.losers, $('bodyLoss'))
  replantExpandRow()

  if (state.expanded) {
    const row = snap.all.find((r) => r.variety === state.expanded.variety)
    if (row && state.expanded.tab === 'kline' && state.expanded.kline) applyLiveToPanel(row)
  }
}

const COLS = ['rank', 'name', 'contract', 'pct', 'pct1', 'price', 'oi', 'vol', 'turnover', 'flag']
function cells() {
  const cls = { rank: 'rank', name: 'name', contract: 'contract', pct: 'num pct', pct1: 'num', price: 'num', oi: 'num', vol: 'num', turnover: 'num', flag: '' }
  return COLS.map((c) => `<td class="${cls[c]}" data-f="${c}"></td>`).join('')
}

function paint(kind, rows, tbody) {
  const pool = state.rows[kind]
  const before = new Map()
  for (const tr of tbody.children) if (tr.dataset.variety) before.set(tr.dataset.variety, tr.getBoundingClientRect().top)

  const seen = new Set()
  let prev = null
  for (const r of rows) {
    seen.add(r.variety)
    let tr = pool.get(r.variety)
    if (!tr) {
      tr = document.createElement('tr')
      tr.dataset.variety = r.variety
      tr.dataset.kind = kind
      tr.innerHTML = cells()
      tr.addEventListener('click', () => toggleExpand(r.variety, kind))
      pool.set(r.variety, tr)
    }
    fill(tr, r)
    tr.hidden = state.filter ? !(r.name.includes(state.filter) || r.variety.includes(state.filter)) : false
    tr.dataset.selected = state.expanded?.variety === r.variety ? '1' : '0'
    tr.classList.toggle('open', state.expanded?.variety === r.variety)
    if (prev ? prev.nextSibling !== tr : tbody.firstChild !== tr) tbody.insertBefore(tr, prev ? prev.nextSibling : tbody.firstChild)
    prev = tr
  }
  for (const [v, tr] of pool) if (!seen.has(v)) { tr.remove(); pool.delete(v) }

  for (const tr of tbody.children) {
    if (!tr.dataset.variety) continue
    const b = before.get(tr.dataset.variety)
    if (b === undefined) continue
    if (tr.matches(':hover') || tr.dataset.selected === '1') continue
    const dy = b - tr.getBoundingClientRect().top
    if (Math.abs(dy) > 0.5) tr.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 250, easing: 'ease-out' })
  }
}

function fill(tr, r) {
  const set = (f, html, dir, flash) => {
    const td = tr.querySelector(`[data-f="${f}"]`)
    if (!td) return
    if (td.dataset.v !== undefined && td.dataset.v !== String(html) && flash) {
      td.classList.remove('flashUp', 'flashDown')
      void td.offsetWidth
      td.classList.add(flash)
    }
    td.dataset.v = String(html)
    if (td.textContent !== String(html).replace(/<[^>]+>/g, '')) td.innerHTML = html
    td.classList.toggle('up', dir === 'up')
    td.classList.toggle('down', dir === 'down')
  }
  const rc = r.rank_change
  set('rank', `${r.rank}${rc ? `<span class="rc ${rc > 0 ? 'up' : 'down'}">${rc > 0 ? '↑' : '↓'}${Math.abs(rc)}</span>` : ''}`)
  set('name', esc(r.name))
  set('contract', esc(r.contract))
  set('pct', `${arrow(r.pct_20d)} ${fmtPct(r.pct_20d)}%`, dirOf(r.pct_20d), dirOf(r.pct_20d) === 'up' ? 'flashUp' : 'flashDown')
  set('pct1', r.pct_1d === null ? '—' : `${fmtPct(r.pct_1d)}%`, dirOf(r.pct_1d), dirOf(r.pct_1d) === 'up' ? 'flashUp' : 'flashDown')
  set('price', fmtNum(r.price, r.price >= 1000 ? 1 : 2), dirOf(r.pct_1d))
  set('oi', r.oi ? `${fmtInt(r.oi)}${r.oi_change === null ? '' : ` (${r.oi_change > 0 ? '+' : ''}${fmtInt(r.oi_change)})`}` : '—', r.oi_change > 0 ? 'up' : r.oi_change < 0 ? 'down' : '')
  set('vol', fmtInt(r.volume))
  set('turnover', r.turnover ? fmtInt(r.turnover) : '—')
  const flags = [r.is_live ? '<span class="flag live">●实时</span>' : '<span class="flag daily">○日报</span>']
  if (r.base_shifted) flags.push('<span class="flag">基准前移</span>')
  if (r.rolled_over) flags.push('<span class="flag">新交易日</span>')
  set('flag', flags.join(''))
}

// ══════════════════════════════════════════════════════════════════════════
//  就地展开
// ══════════════════════════════════════════════════════════════════════════
const TABS = [
  ['kline', '日K图'],
  ['logic', '硬逻辑'],
  ['theme', '题材龙头'],
  ['data', '数据溯源'],
]

function toggleExpand(variety, kind) {
  if (state.expanded?.variety === variety) return collapse()
  collapse(true)
  state.expanded = {
    variety, kind, tab: 'kline', kline: null, logic: null, loading: true, error: null,
    zoomIdx: ZOOM_DEFAULT, offset: 0, hoverDate: null, pickedDate: null,
  }
  markSelected()
  replantExpandRow()
  syncScrollPolicy()
  loadPanel(variety)
}

function collapse(silent) {
  if (state.expandEl) { state.expandEl.remove(); state.expandEl = null }
  state.expanded = null
  syncScrollPolicy()
  if (!silent) markSelected()
}

/**
 * 滚动策略：默认整页不滚动（双榜一屏看全、榜内零滚动条）；
 * 只有展开了行内详情或运行状态时才放开**页面**滚动 —— 榜单本身始终不出现内部滚动条。
 */
function syncScrollPolicy() {
  document.body.classList.toggle('expanded', !!state.expanded)
  const ops = $('ops')
  document.body.classList.toggle('ops-open', !!ops && !ops.classList.contains('collapsed'))
}

function markSelected() {
  for (const kind of ['gain', 'loss']) {
    for (const [, tr] of state.rows[kind]) {
      const on = state.expanded?.variety === tr.dataset.variety
      tr.dataset.selected = on ? '1' : '0'
      tr.classList.toggle('open', on)
    }
  }
}

function replantExpandRow() {
  if (!state.expanded) return
  const tr = state.rows[state.expanded.kind]?.get(state.expanded.variety)
  if (!tr || !tr.parentNode) { collapse(true); return }
  if (!state.expandEl) state.expandEl = buildExpandRow()
  tr.parentNode.insertBefore(state.expandEl, tr.nextSibling)
}

function buildExpandRow() {
  const tr = document.createElement('tr')
  tr.className = 'expandRow'
  tr.innerHTML = `<td colspan="10"><div class="panel" id="expandPanel"></div></td>`
  tr.addEventListener('click', (e) => e.stopPropagation())
  return tr
}

async function loadPanel(variety) {
  const p = $('expandPanel')
  if (!p) return
  p.innerHTML = `<div class="panelLoad">正在加载日K线与硬逻辑…</div>`
  try {
    const [k, l] = await Promise.all([
      fetch(`/api/variety/${variety}/kline?days=250`).then((r) => r.json()),
      fetch(`/api/variety/${variety}/logic`).then((r) => (r.ok ? r.json() : null)),
    ])
    if (state.expanded?.variety !== variety) return
    state.expanded.kline = k
    state.expanded.logic = l
    state.expanded.loading = false
  } catch (e) {
    if (state.expanded?.variety !== variety) return
    state.expanded.error = String(e)
    state.expanded.loading = false
  }
  renderPanel()
}

/** 每个导航条板块的内容 HTML（测量与渲染共用同一份）*/
function paneBody(tab, ex, row) {
  if (tab === 'kline') return klinePane(ex, row)
  if (tab === 'logic') return renderLogic(ex.logic)
  if (tab === 'theme') return renderTheme(ex.logic)
  return renderData(ex.kline, row)
}

/**
 * 自适应面板高度：**四个板块高度一致，且内容完整展示、无内部滚动条**。
 *
 * 做法：把四个板块的内容依次放进一个同宽、脱离文档流的测量容器里量 scrollHeight，
 * 取最大值作为面板固定高度。这样切换板块不跳动，也不会出现滚动条。
 */
function fitPanelHeight(p) {
  const ex = state.expanded
  if (!ex) return
  const body = p.querySelector('.panelBody')
  if (!body) return
  const row = state.snap?.all?.find((r) => r.variety === ex.variety)
  const w = body.clientWidth
  const probe = document.createElement('div')
  probe.className = 'panelBody measure'
  probe.style.width = `${w}px`
  document.body.appendChild(probe)
  let max = 0
  for (const [k] of TABS) {
    probe.innerHTML = paneBody(k, ex, row)
    max = Math.max(max, probe.scrollHeight)
  }
  probe.remove()
  ex.fitH = Math.max(320, max + 6)
  body.style.height = `${ex.fitH}px`
}

function renderPanel() {
  const ex = state.expanded
  const p = $('expandPanel')
  if (!ex || !p) return
  const row = state.snap?.all?.find((r) => r.variety === ex.variety)
  const name = row?.name ?? ex.kline?.name ?? ex.variety
  const contract = row?.contract ?? ex.kline?.contract ?? ''

  const nav = `<nav class="panelNav" role="tablist">
    ${TABS.map(([k, t]) => `<button role="tab" data-tab="${k}" class="${ex.tab === k ? 'active' : ''}" aria-selected="${ex.tab === k}">${t}</button>`).join('')}
    <span class="panelHead">
      <b>${esc(name)}</b> <code>${esc(contract)}</code>
      ${row ? `<span class="pill small" data-state="${row.is_live ? 'ok' : 'warn'}"><span class="dot"></span><span>${row.is_live ? '实时' : '日报'}</span></span>` : ''}
      <span class="muted">20日 ${fmtPct(row?.pct_20d)}%</span>
    </span>
    <button class="panelClose" title="折叠 (Esc)">✕ 折叠</button>
  </nav>`

  let body = ''
  if (ex.loading) body = `<div class="panelLoad">加载中…</div>`
  else if (ex.error) body = `<div class="panelLoad">加载失败：${esc(ex.error)}</div>`
  else body = paneBody(ex.tab, ex, row)

  p.innerHTML = nav + `<div class="panelBody"${ex.fitH ? ` style="height:${ex.fitH}px"` : ''}>${body}</div>`

  p.querySelectorAll('.panelNav button[data-tab]').forEach((b) =>
    b.addEventListener('click', () => { ex.tab = b.dataset.tab; renderPanel() }))
  p.querySelector('.panelClose').addEventListener('click', () => collapse())

  // 数据就绪后测一次，四个板块统一高度
  if (!ex.loading && !ex.error && !ex.fitH) requestAnimationFrame(() => fitPanelHeight(p))

  if (ex.tab === 'kline' && !ex.loading && !ex.error) {
    // 缩放按钮：放大 / 缩小 / 还原
    $('kzoomIn')?.addEventListener('click', () => {
      if ((ex.zoomIdx ?? ZOOM_DEFAULT) > 0) { ex.zoomIdx--; clampOffset(ex); drawChart(); updateReadout() }
    })
    $('kzoomOut')?.addEventListener('click', () => {
      if ((ex.zoomIdx ?? ZOOM_DEFAULT) < ZOOM_LEVELS.length - 1) { ex.zoomIdx++; clampOffset(ex); drawChart(); updateReadout() }
    })
    $('kreset')?.addEventListener('click', () => {
      ex.zoomIdx = ZOOM_DEFAULT
      ex.offset = 0
      ex.pickedDate = null
      ex.hoverDate = null
      drawChart()
      updateReadout()
    })
    $('kclear')?.addEventListener('click', () => { ex.pickedDate = null; drawChart(); updateReadout() })
    drawChart()
    updateReadout()
  }
}

function klinePane(ex, row) {
  const max = ex.kline?.bars?.length ?? 0
  return `
  <div class="chartBar">
    <span class="zoomGroup">
      <button id="kzoomIn"  title="放大（显示更少根 / 滚轮上滚）">＋ 放大</button>
      <button id="kzoomOut" title="缩小（显示更多根 / 滚轮下滚）">－ 缩小</button>
      <button id="kreset" class="reset" title="还原到默认 60 根并回到最新">⟲ 还原</button>
    </span>
    <span class="muted" id="kmeta"></span>
    <button class="ghostBtn" id="kclear">清除选中</button>
    <span class="muted tipHint">划过看读数 · <b>点击</b>该根固定到下方 · 可左右拖动平移</span>
  </div>
  <div class="chartWrap" id="chartWrap"><canvas id="kchart"></canvas></div>
  <div class="chartLegend" id="chartLegend"></div>
  <div class="barReadout" id="barReadout"></div>`
}

// ── 缩放模型：zoomIdx 决定可见根数，offset 是从右端往左的偏移（0 = 显示最新）──
const ZOOM_LEVELS = [20, 30, 45, 60, 80, 120, 160, 250, Infinity]
const ZOOM_DEFAULT = 3 // → 60 根

function zoomCount(ex) {
  const total = ex.kline?.bars?.length ?? 0
  const want = ZOOM_LEVELS[ex.zoomIdx ?? ZOOM_DEFAULT]
  return want === Infinity ? total : Math.min(want, total)
}
function clampOffset(ex) {
  const total = ex.kline?.bars?.length ?? 0
  const cnt = zoomCount(ex)
  const maxOff = Math.max(0, total - cnt)
  ex.offset = Math.min(Math.max(0, ex.offset ?? 0), maxOff)
}

// ── 硬逻辑 ───────────────────────────────────────────────────────────────
function renderLogic(L) {
  if (!L) return `<div class="panelLoad">无数据（该品种不在当前榜单中）</div>`
  const dirCls = L.direction === 'long' ? 'up' : L.direction === 'short' ? 'down' : ''
  return `
  <div class="logicGrid">
    <div class="logicCard">
      <h4>方向</h4>
      <div class="dirBig ${dirCls}">${esc(L.directionCN)}</div>
      <div class="muted">依据：20 日涨跌幅符号 + 当日动能 + 持仓变化（规则推导）</div>
    </div>
    <div class="logicCard">
      <h4>做多 / 做空硬逻辑</h4>
      <ul class="hardList">${(L.hardLogic ?? []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">无</li>'}</ul>
    </div>
    <div class="logicCard">
      <h4>失效条件（可机器判定）</h4>
      <ul class="invList">${(L.invalidation ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>
  </div>
  <div class="srcNotice ${L.modelConnected ? 'ok' : 'warn'}">
    <b>生成方式：${esc(L.generatedBy)}</b> —— ${esc(L.modelNote ?? '')}
  </div>
  <h4 class="secTitle">证据链（每条均来自真实数据）</h4>
  <table class="evTable">
    <thead><tr><th>类别</th><th>项</th><th class="num">值</th><th>说明</th><th>来源</th></tr></thead>
    <tbody>${(L.evidence ?? []).map((e) => `<tr>
        <td class="evKind">${esc(e.kind)}</td><td>${esc(e.label)}</td>
        <td class="num">${esc(e.value)}</td><td class="muted">${esc(e.detail ?? '')}</td>
        <td><span class="srcTag ${srcCls(e.source)}">${esc(e.source)}</span></td></tr>`).join('')}</tbody>
  </table>`
}

// ── 题材 / 龙头 / 确认日（独立板块）────────────────────────────────────
function renderTheme(L) {
  if (!L) return `<div class="panelLoad">无数据（该品种不在当前榜单中）</div>`
  const ev = (L.evidence ?? []).filter((e) => ['板块', '龙头', '确认日'].includes(e.kind))
  const sectorEv = ev.find((e) => e.kind === '板块')
  const leaderEv = ev.find((e) => e.kind === '龙头')
  const confirmEv = ev.find((e) => e.kind === '确认日')
  const peers = L.peers ?? []
  return `
  <div class="themeGrid">
    <div class="themeCard">
      <h4>涨跌题材 · 板块</h4>
      <div class="themeBig">${esc(L.sector)}</div>
      <div class="muted">${esc(sectorEv?.value ?? '')}</div>
      <div class="muted small">${esc(sectorEv?.detail ?? '')}</div>
      <div class="srcLine">分类来源：<span class="srcTag derived">本项目内置分类表</span></div>
    </div>

    <div class="themeCard">
      <h4>龙头地位</h4>
      <div class="themeBig">${L.leader ? '<span class="badge ok">板块龙头</span>' : '<span class="muted">非板块第一</span>'}</div>
      <div class="muted">${esc(leaderEv?.detail ?? '判定规则：同板块内 |20日涨跌幅| 最大者')}</div>
      <div class="muted small">${esc(leaderEv?.value ?? '')}</div>
    </div>

    <div class="themeCard">
      <h4>确认日</h4>
      <div class="themeBig">${L.confirmDate ? dlong(L.confirmDate) : '<span class="muted">尚未出现</span>'}</div>
      <div class="muted">${esc(L.confirmNote ?? confirmEv?.detail ?? '')}</div>
      <div class="muted small">判定：最近一次创近 20 日收盘新高/新低（真实 OHLC）</div>
    </div>
  </div>

  <h4 class="secTitle">板块与确认日证据</h4>
  <table class="evTable">
    <thead><tr><th>类别</th><th>项</th><th class="num">值</th><th>说明</th><th>来源</th></tr></thead>
    <tbody>${ev.map((e) => `<tr>
        <td class="evKind">${esc(e.kind)}</td><td>${esc(e.label)}</td>
        <td class="num">${esc(e.value)}</td><td class="muted">${esc(e.detail ?? '')}</td>
        <td><span class="srcTag ${srcCls(e.source)}">${esc(e.source)}</span></td></tr>`).join('')}</tbody>
  </table>`
}

function srcCls(s) {
  return s === 'official_eod' ? 'official' : s === 'sina_live' ? 'live' : s === 'unavailable' ? 'na' : 'derived'
}

function renderData(K, row) {
  const sb = K?.sourceBreakdown ?? {}
  const m = [
    ['20 日涨跌幅', `${fmtPct(row?.pct_20d)}%`],
    ['当日涨跌幅', row?.pct_1d === null || row?.pct_1d === undefined ? '—' : `${fmtPct(row.pct_1d)}%`],
    ['最新价', fmtNum(row?.price, 4)],
    ['今开 / 最高 / 最低', `${fmtNum(row?.open, 2)} / ${fmtNum(row?.high, 2)} / ${fmtNum(row?.low, 2)}`],
    ['基准日结算价（分母）', `${fmtNum(row?.base_settle, 4)} @ ${row?.base_date ?? '—'}`],
    ['持仓量（变化）', row?.oi ? `${fmtInt(row.oi)}${row.oi_change === null ? '' : ` (${row.oi_change > 0 ? '+' : ''}${fmtInt(row.oi_change)})`}` : '—'],
    ['成交量', fmtInt(row?.volume)],
    ['成交额', row?.turnover ? `${fmtInt(row.turnover)}（万元）` : '—'],
    ['K 线根数', K?.bars?.length ? `${K.bars.length} 根（${dlong(K.bars[0].d)} → ${dlong(K.bars[K.bars.length - 1].d)}）` : '—'],
    ['官方日报覆盖起点', K?.officialFrom ? dlong(K.officialFrom) : '—'],
    ['K 线更新时间', K?.updatedAt ? new Date(K.updatedAt).toLocaleString('zh-CN') : '—'],
    ['正在形成的交易日', K?.liveBarDate ? dlong(K.liveBarDate) : '—'],
    ['数据来源 source', esc(row?.source ?? '—')],
    ['行情时间 quote_time', esc(row?.quote_time || '—')],
  ].map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('')
  return `<div class="dataGrid">
    <div><h4 class="secTitle">幅度与溯源</h4><table class="kvTable">${m}</table></div>
    <div><h4 class="secTitle">K 线来源构成</h4>
      <table class="kvTable"><tbody>${Object.entries(sb).map(([k, v]) =>
        `<tr><td><span class="srcTag ${k.startsWith('eod') ? 'official' : k === 'live' ? 'live' : 'derived'}">${esc(k)}</span></td><td class="num">${v} 根</td></tr>`).join('') || '<tr><td class="muted">无 K 线数据</td></tr>'}</tbody></table>
      <div class="muted small" style="margin-top:10px">${esc(K?.note ?? '')}</div>
    </div></div>`
}

// ── 实时联动 ─────────────────────────────────────────────────────────────
function applyLiveToPanel(row) {
  const K = state.expanded.kline
  if (!K?.bars?.length || !row.is_live || !(row.price > 0)) return
  const liveD = String(state.snap.tradeDate ?? '')
  if (!/^\d{8}$/.test(liveD)) return
  const bars = K.bars
  const last = bars[bars.length - 1]
  if (String(last.src).startsWith('eod')) return
  if (liveD > last.d) {
    bars.push({ d: liveD, o: row.open ?? row.price, h: row.high ?? row.price, l: row.low ?? row.price, c: row.price, s: 0, v: row.volume ?? 0, oi: row.oi ?? 0, src: 'live' })
    K.liveBarDate = liveD
  } else if (liveD === last.d) {
    last.h = Math.max(last.h ?? last.c, row.high ?? row.price)
    last.l = Math.min(last.l ?? last.c, row.low ?? row.price)
    last.c = row.price
    last.v = row.volume ?? last.v
    last.oi = row.oi ?? last.oi
    last.src = 'live'
  } else return
  if (state.expanded.tab === 'kline') { drawChart(); updateReadout() }
}

// ══════════════════════════════════════════════════════════════════════════
//  Canvas 蜡烛图（整图重绘，避免残留；含时间横轴 / 十字光标 / 点击固定）
// ══════════════════════════════════════════════════════════════════════════
const CH = { main: 250, vol: 64, oi: 64, axis: 26, top: 10, right: 64, left: 8 }
const chTotal = () => CH.top + CH.main + CH.vol + CH.oi + CH.axis

/**
 * 视口（**亚根精度**）。
 *
 * 关键：`offset` 是**浮点**的根数偏移，绘制时按小数部分做整像素平移。
 * 若像早期实现那样把 offset 取整，拖动会一格一格地跳 —— 尤其 250 根时 step 只有 3px，
 * 表现就是"拖动不连贯、发黏"。
 *
 * @returns {{bars:Array, i0:number, startF:number}} startF = 视口左端对应的浮点绝对下标
 */
function viewport() {
  const ex = state.expanded
  if (!ex?.kline?.bars?.length) return { bars: [], i0: 0, startF: 0 }
  const all = ex.kline.bars
  const cnt = zoomCount(ex)
  const maxOff = Math.max(0, all.length - cnt)
  ex.offset = Math.min(Math.max(0, ex.offset ?? 0), maxOff)
  const endF = all.length - ex.offset      // 浮点右端
  const startF = Math.max(0, endF - cnt)   // 浮点左端
  const i0 = Math.floor(startF)
  const i1 = Math.min(all.length, Math.ceil(endF))
  return { bars: all.slice(i0, i1), i0, startF }
}

function visibleBars() {
  return viewport().bars
}

// 配色只解析一次（避免每帧 getComputedStyle 触发样式重算 → 拖动卡顿）
let THEME = null
function themeColors() {
  if (THEME) return THEME
  const css = getComputedStyle(document.documentElement)
  THEME = {
    up: css.getPropertyValue('--up').trim() || '#ff5c5c',
    down: css.getPropertyValue('--down').trim() || '#35d07f',
    txt: 'rgba(180,190,205,.9)',
    grid: 'rgba(255,255,255,.07)',
    axis: 'rgba(255,255,255,.18)',
  }
  return THEME
}

// ── 图表交互（模块级状态 + 只绑定一次）──────────────────────────────────
const drag = { active: false, x: 0, off: 0, moved: false }
let chartRaf = 0
let geo = null // { cv, bars, step, vp, idxAt }

function scheduleDraw(readout = true) {
  if (chartRaf) return
  chartRaf = requestAnimationFrame(() => {
    chartRaf = 0
    drawChart()
    if (readout) updateReadout()
  })
}

function bindChart(cv) {
  if (cv.dataset.bound === '1') return
  cv.dataset.bound = '1'
  const ex = () => state.expanded

  cv.addEventListener('mousemove', (ev) => {
    if (!geo) return
    const e = ex()
    if (drag.active) {
      // ⚠️ offset 用**浮点**（不 round）：取整会让拖动一格一格跳，
      //    250 根时 step 仅约 3px，表现就是"拖动不连贯、发黏"。
      e.offset = drag.off + (ev.clientX - drag.x) / geo.step
      clampOffset(e)
      drag.moved = true
      scheduleDraw()
      return
    }
    const i = geo.idxAt(ev)
    const d = i === null ? null : geo.bars[i].d
    if (d === e.hoverDate) return
    e.hoverDate = d
    scheduleDraw()
  })

  cv.addEventListener('mouseleave', () => {
    if (drag.active) return
    const e = ex()
    if (e) { e.hoverDate = null; scheduleDraw() }
  })

  cv.addEventListener('pointerdown', (ev) => {
    const e = ex()
    if (!e) return
    drag.active = true
    drag.moved = false
    drag.x = ev.clientX
    drag.off = e.offset ?? 0
    try { cv.setPointerCapture(ev.pointerId) } catch { /* ignore */ }
    cv.style.cursor = 'grabbing'
  })

  const endDrag = (ev) => {
    if (!drag.active) return
    drag.active = false
    try { if (ev?.pointerId !== undefined) cv.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
    cv.style.cursor = 'crosshair'
    const e = ex()
    if (e) { e.offset = Math.round(e.offset ?? 0); scheduleDraw() } // 松手归整到整根
  }
  cv.addEventListener('pointerup', endDrag)
  cv.addEventListener('pointercancel', endDrag)

  cv.addEventListener('click', (ev) => {
    if (drag.moved) { drag.moved = false; return } // 拖动结束那次 click 不算选中
    const e = ex()
    if (!e || !geo) return
    const i = geo.idxAt(ev)
    if (i === null) return
    const d = geo.bars[i].d
    e.pickedDate = e.pickedDate === d ? null : d // 再点同一根取消
    drawChart()
    updateReadout()
  })

  // 滚轮缩放（以鼠标所在那根为锚点）
  cv.addEventListener('wheel', (ev) => {
    ev.preventDefault()
    const e = ex()
    if (!e || !geo) return
    const i = geo.idxAt(ev)
    const anchorDate = i === null ? null : geo.bars[i].d
    const dir = ev.deltaY < 0 ? -1 : 1 // 上滚 = 放大
    const next = Math.min(Math.max((e.zoomIdx ?? ZOOM_DEFAULT) + dir, 0), ZOOM_LEVELS.length - 1)
    if (next === e.zoomIdx) return
    e.zoomIdx = next
    clampOffset(e)
    // 锚点尽量保持在鼠标下方
    if (anchorDate) {
      const beforeIdx = geo.bars.findIndex((b) => b.d === anchorDate)
      const after = visibleBars()
      const newIdx = after.findIndex((b) => b.d === anchorDate)
      if (beforeIdx >= 0 && newIdx >= 0) {
        e.offset = (e.offset ?? 0) - (beforeIdx - newIdx)
        clampOffset(e)
      }
    }
    drawChart()
    updateReadout()
  }, { passive: false })
}

let LEGEND_SIG = ''

function drawChart() {
  const cv = $('kchart')
  const wrap = $('chartWrap')
  const ex = state.expanded
  if (!cv || !wrap || !ex) return
  const vp = viewport()
  const bars = vp.bars
  const meta = $('kmeta')
  if (meta && ex.kline) {
    const tot = ex.kline.bars.length
    const off = Math.round(ex.offset ?? 0)
    const posTip = off === 0 ? '最新' : `左移 ${off} 根`
    const mt = `共 ${tot} 根 · 显示 ${Math.min(zoomCount(ex), tot)} 根（${dlong(bars[0]?.d)} → ${dlong(bars[bars.length - 1]?.d)}，${posTip}）`
    if (meta.textContent !== mt) meta.textContent = mt
    const zi = ex.zoomIdx ?? ZOOM_DEFAULT
    const bIn = $('kzoomIn'); const bOut = $('kzoomOut')
    if (bIn) bIn.disabled = zi <= 0
    if (bOut) bOut.disabled = zi >= ZOOM_LEVELS.length - 1
  }
  if (!bars.length) {
    wrap.innerHTML = `<div class="panelLoad">暂无 K 线数据 —— ${esc(ex.kline?.note ?? '该合约可能刚上市或数据源未覆盖')}</div>`
    return
  }

  const dpr = window.devicePixelRatio || 1
  const W = Math.max(360, wrap.clientWidth)
  const H = chTotal()
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.style.width = `${W}px`
    cv.style.height = `${H}px`
    cv.width = Math.round(W * dpr)
    cv.height = Math.round(H * dpr)
  }
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, W, H)

  const plotW = W - CH.left - CH.right
  const cnt = zoomCount(ex)
  const n = bars.length
  const step = plotW / cnt
  const bw = Math.max(2, Math.min(16, step * 0.66))
  // 亚根平移：第 k 根（绝对下标）的横坐标 = left + (k - startF + 0.5) * step
  const x = (k) => CH.left + (vp.i0 + k - vp.startF + 0.5) * step

  const y0 = CH.top
  const yMainBot = y0 + CH.main
  const lo = Math.min(...bars.map((b) => (Number.isFinite(b.l) ? b.l : b.c)))
  const hi = Math.max(...bars.map((b) => (Number.isFinite(b.h) ? b.h : b.c)))
  const padv = (hi - lo) * 0.06 || 1
  const y = (p) => yMainBot - ((p - (lo - padv)) / (hi - lo + padv * 2)) * (CH.main - 8) - 4

  const tc = themeColors()
  const C_UP = tc.up
  const C_DOWN = tc.down
  const C_TXT = tc.txt
  const C_GRID = tc.grid
  const C_AXIS = tc.axis

  // 网格 + 价格刻度
  g.font = '10.5px ui-monospace, Consolas, monospace'
  g.textAlign = 'left'
  for (let i = 0; i <= 4; i++) {
    const p = lo - padv + ((hi - lo + padv * 2) * i) / 4
    const yy = y(p)
    g.strokeStyle = C_GRID
    g.beginPath(); g.moveTo(CH.left, yy); g.lineTo(CH.left + plotW, yy); g.stroke()
    g.fillStyle = C_TXT
    g.fillText(p.toFixed(p > 1000 ? 0 : 2), CH.left + plotW + 6, yy + 3)
  }

  // 均线
  const ma = (k) => bars.map((_, i) => (i + 1 < k ? null : bars.slice(i + 1 - k, i + 1).reduce((a, b) => a + b.c, 0) / k))
  const drawMa = (arr, color) => {
    g.strokeStyle = color; g.lineWidth = 1.2; g.beginPath()
    let started = false
    arr.forEach((v, i) => {
      if (v === null) return
      const px = x(i), py = y(v)
      started ? g.lineTo(px, py) : (g.moveTo(px, py), (started = true))
    })
    g.stroke()
  }
  drawMa(ma(5), '#e8c46a'); drawMa(ma(10), '#6aa9e8'); drawMa(ma(20), '#c58fe8')

  // 选中/悬停高亮带（按**日期**定位，缩放/平移后仍能对上）
  const pickIdx = ex.pickedDate ? bars.findIndex((b) => b.d === ex.pickedDate) : -1
  const hovIdx = ex.hoverDate ? bars.findIndex((b) => b.d === ex.hoverDate) : -1
  const mark = pickIdx >= 0 ? pickIdx : hovIdx
  if (mark >= 0) {
    g.fillStyle = pickIdx >= 0 ? 'rgba(74,158,255,.16)' : 'rgba(255,255,255,.06)'
    g.fillRect(x(mark) - step / 2, y0, step, yMainBot - y0)
  }

  // 蜡烛
  bars.forEach((b, i) => {
    const up = b.c >= b.o
    const col = up ? C_UP : C_DOWN
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1
    const cx = x(i)
    g.beginPath(); g.moveTo(cx, y(b.h)); g.lineTo(cx, y(b.l)); g.stroke()
    const yo = y(b.o), yc = y(b.c)
    const top = Math.min(yo, yc)
    g.fillRect(cx - bw / 2, top, bw, Math.max(1, Math.abs(yc - yo)))
    if (b.src === 'live') {
      g.save(); g.strokeStyle = '#4a9eff'; g.lineWidth = 1.5
      g.strokeRect(cx - bw / 2 - 1.5, y(b.h) - 1.5, bw + 3, y(b.l) - y(b.h) + 3)
      g.restore()
    }
  })

  // 基准日竖线
  const refD = ex.kline?.refDate
  if (refD) {
    const idx = bars.findIndex((b) => b.d >= refD)
    if (idx >= 0) {
      g.save(); g.setLineDash([4, 3]); g.strokeStyle = 'rgba(245,165,36,.85)'; g.lineWidth = 1
      g.beginPath(); g.moveTo(x(idx), y0); g.lineTo(x(idx), yMainBot + CH.vol + CH.oi); g.stroke()
      g.restore()
      g.fillStyle = 'rgba(245,165,36,.95)'; g.font = '10.5px sans-serif'
      g.fillText(`基准日 ${dstr(refD)}`, Math.min(x(idx) + 4, W - 96), y0 + 11)
      g.font = '10.5px ui-monospace, Consolas, monospace'
    }
  }

  // 成交量副图
  const vTop = yMainBot
  g.strokeStyle = C_AXIS; g.beginPath(); g.moveTo(CH.left, vTop); g.lineTo(CH.left + plotW, vTop); g.stroke()
  g.fillStyle = C_TXT; g.fillText('成交量', CH.left + 2, vTop + 12)
  const vMax = Math.max(...bars.map((b) => b.v || 0)) || 1
  bars.forEach((b, i) => {
    const hh = ((b.v || 0) / vMax) * (CH.vol - 20)
    g.fillStyle = b.c >= b.o ? C_UP : C_DOWN
    g.globalAlpha = 0.6
    g.fillRect(x(i) - bw / 2, vTop + CH.vol - hh - 4, bw, hh)
    g.globalAlpha = 1
  })

  // 持仓量副图
  const oTop = vTop + CH.vol
  g.strokeStyle = C_AXIS; g.beginPath(); g.moveTo(CH.left, oTop); g.lineTo(CH.left + plotW, oTop); g.stroke()
  g.fillStyle = C_TXT; g.fillText('持仓量', CH.left + 2, oTop + 12)
  const oiVals = bars.map((b) => b.oi || 0).filter((v) => v > 0)
  if (oiVals.length > 1) {
    const oMin = Math.min(...oiVals), oMax = Math.max(...oiVals)
    g.strokeStyle = '#8fb7ff'; g.lineWidth = 1.3; g.beginPath()
    let started = false
    bars.forEach((b, i) => {
      if (!b.oi) return
      const py = oTop + CH.oi - 6 - ((b.oi - oMin) / (oMax - oMin || 1)) * (CH.oi - 22)
      started ? g.lineTo(x(i), py) : (g.moveTo(x(i), py), (started = true))
    })
    g.stroke()
    g.fillStyle = C_TXT
    g.fillText(fmtInt(oMax), CH.left + plotW + 6, oTop + 20)
    g.fillText(fmtInt(oMin), CH.left + plotW + 6, oTop + CH.oi - 6)
  }

  // ── 时间横轴（原来缺失）────────────────────────────────────────────
  const axTop = oTop + CH.oi
  g.strokeStyle = C_AXIS; g.beginPath(); g.moveTo(CH.left, axTop); g.lineTo(CH.left + plotW, axTop); g.stroke()
  const every = Math.max(1, Math.ceil(n / Math.max(4, Math.floor(plotW / 78))))
  g.fillStyle = C_TXT
  g.textAlign = 'center'
  bars.forEach((b, i) => {
    if (i % every !== 0 && i !== n - 1) return
    const px = x(i)
    g.strokeStyle = C_AXIS; g.beginPath(); g.moveTo(px, axTop); g.lineTo(px, axTop + 4); g.stroke()
    const label = b.d.length === 8 ? `${b.d.slice(4, 6)}/${b.d.slice(6, 8)}` : b.d
    g.fillText(label, Math.min(Math.max(px, 18), CH.left + plotW - 18), axTop + 17)
  })
  // 年份提示（跨越年份时）
  const years = new Set(bars.map((b) => b.d.slice(0, 4)))
  if (years.size > 1) {
    g.textAlign = 'right'
    g.fillText([...years].join('/'), CH.left + plotW, axTop + 17)
  }
  g.textAlign = 'left'

  // 十字光标（每帧整图重绘 → 不留残影）
  const hov = hovIdx >= 0 ? hovIdx : -1
  if (hov >= 0 && bars[hov]) {
    const hb = bars[hov]
    const cx = x(hov)
    g.save()
    g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1
    g.beginPath(); g.moveTo(cx, y0); g.lineTo(cx, axTop); g.stroke()
    g.beginPath(); g.moveTo(CH.left, y(hb.c)); g.lineTo(CH.left + plotW, y(hb.c)); g.stroke()
    g.restore()
    // 右侧价格气泡
    g.fillStyle = 'rgba(74,158,255,.9)'
    g.fillRect(CH.left + plotW + 2, y(hb.c) - 8, CH.right - 6, 16)
    g.fillStyle = '#fff'; g.textAlign = 'left'
    g.fillText(hb.c.toFixed(hb.c > 1000 ? 0 : 2), CH.left + plotW + 6, y(hb.c) + 3)
    // 顶部日期气泡
    const lbl = dlong(hb.d)
    const tw = g.measureText(lbl).width + 12
    g.fillStyle = 'rgba(74,158,255,.9)'
    g.fillRect(Math.min(cx - tw / 2, W - tw - 2), y0 - 2, tw, 16)
    g.fillStyle = '#fff'; g.textAlign = 'center'
    g.fillText(lbl, Math.min(cx, W - tw / 2 - 2), y0 + 10)
    g.textAlign = 'left'
  }

  // 图例（内容未变则不重排 DOM —— 拖动时每帧写 innerHTML 会引发布局抖动）
  const legend = $('chartLegend')
  if (legend) {
    const last = bars[bars.length - 1]
    const sig = `${ex.kline?.refDate}|${last.d}|${last.src}`
    if (sig !== LEGEND_SIG) {
      LEGEND_SIG = sig
      legend.innerHTML = [
        `<span class="lg"><i style="background:#e8c46a"></i>MA5</span>`,
        `<span class="lg"><i style="background:#6aa9e8"></i>MA10</span>`,
        `<span class="lg"><i style="background:#c58fe8"></i>MA20</span>`,
        `<span class="lg"><i class="dash"></i>基准日 ${dstr(ex.kline?.refDate ?? '')}</span>`,
        `<span class="lg"><i class="live"></i>形成中</span>`,
        `<span class="lg muted">最后一根 ${dlong(last.d)}${last.src === 'live' ? '（形成中）' : ''}</span>`,
      ].join('')
    }
  }

  // 反解横坐标 → 局部下标（与 x() 用同一套亚根平移公式）
  const idxAt = (ev) => {
    const rect = cv.getBoundingClientRect()
    const mx = ev.clientX - rect.left
    const k = (mx - CH.left) / step - (vp.i0 - vp.startF + 0.5)
    const i = Math.round(k)
    return i >= 0 && i < n ? i : null
  }

  // 交互：几何信息存到模块级 geo，**事件只在画布创建时绑定一次**
  // ⚠️ 早期实现把 dragging/dragOff/raf 放在 drawChart 内部并在末尾重新绑定事件 ——
  //    而 drawChart 每帧都会被调用，于是拖动状态每帧被重置 → 拖动一帧一跳、发黏。
  geo = { cv, bars, step, vp, idxAt }
  bindChart(cv)
  cv.style.cursor = 'crosshair'
  cv.style.touchAction = 'none'
}

/** 图表下方的固定读数面板（点击后固定，不随鼠标移动消失） */
function updateReadout() {
  const el = $('barReadout')
  const ex = state.expanded
  if (!el || !ex) return
  const bars = visibleBars()
  if (!bars.length) { el.innerHTML = ''; return }
  const pickIdx = ex.pickedDate ? bars.findIndex((b) => b.d === ex.pickedDate) : -1
  const hovIdx = ex.hoverDate ? bars.findIndex((b) => b.d === ex.hoverDate) : -1
  const i = pickIdx >= 0 ? pickIdx : hovIdx
  const b = i < 0 ? bars[bars.length - 1] : bars[i]
  const prev = i <= 0 ? null : bars[i - 1]
  const chg = prev ? ((b.c - prev.c) / prev.c) * 100 : null
  const pinned = pickIdx >= 0
  const dir = b.c >= b.o ? 'up' : 'down'
  el.innerHTML = `
    <div class="roHead">
      <b>${dlong(b.d)}</b>
      <span class="srcTag ${b.src.startsWith('eod') ? 'official' : b.src === 'live' ? 'live' : 'derived'}">${b.src}</span>
      ${pinned ? '<span class="pinTag">已固定</span>' : '<span class="muted">（未点击 = 跟随鼠标 / 显示最新）</span>'}
    </div>
    <div class="roGrid">
      <span>开 <b>${fmtNum(b.o, 2)}</b></span>
      <span>高 <b>${fmtNum(b.h, 2)}</b></span>
      <span>低 <b>${fmtNum(b.l, 2)}</b></span>
      <span>收 <b class="${dir}">${fmtNum(b.c, 2)}</b></span>
      <span>较前收 <b class="${dirOf(chg)}">${chg === null ? '—' : fmtPct(chg) + '%'}</b></span>
      <span>结算 <b>${b.s ? fmtNum(b.s, 2) : '—'}</b></span>
      <span>成交量 <b>${fmtInt(b.v)}</b></span>
      <span>持仓量 <b>${fmtInt(b.oi)}</b></span>
      <span>成交额 <b>${b.to ? fmtInt(b.to) + ' 万' : '—'}</b></span>
    </div>`
}

// ══════════════════════════════════════════════════════════════════════════
//  运行状态模块：① 数据源连通性/延迟  ② 模型 API 配置与连通性测试
// ══════════════════════════════════════════════════════════════════════════
const latCls = (ms, ok) => (!ok ? 'r' : ms < 300 ? 'g' : ms < 1000 ? 'y' : 'r')

function renderSources(doc) {
  const rows = [...(doc.sources ?? []), ...(doc.local ?? [])]
  const tbody = $('srcRows')
  if (!tbody) return
  tbody.innerHTML = rows
    .map((s) => {
      const st = s.ok ? '<span class="dot2 ok"></span>正常' : '<span class="dot2 bad"></span>异常'
      const lat = s.latencyMs === undefined ? '—' : `<span class="lat ${latCls(s.latencyMs, s.ok)}">${s.latencyMs}ms<span class="latBar" style="width:${Math.min(40, Math.round(s.latencyMs / 80))}px"></span></span>`
      const note = s.error ? `<span class="bad">${esc(s.error)}</span>` : esc(s.detail ?? '')
      return `<tr class="${s.kind === 'local' ? 'kindLocal' : ''}">
        <td>${esc(s.name)}</td>
        <td class="url" title="${esc(s.url ?? '')}">${esc(s.url ?? '—')}</td>
        <td>${st}</td>
        <td>${lat}</td>
        <td>${note}</td></tr>`
    })
    .join('')

  const remote = (doc.sources ?? []).filter((s) => s.ok).length
  const total = (doc.sources ?? []).length
  const meta = $('srcMeta')
  if (meta) {
    meta.textContent = doc.at
      ? `${remote}/${total} 可用 · 检测耗时 ${doc.elapsedMs}ms · ${new Date(doc.at).toLocaleTimeString('zh-CN')}${doc.cached ? '（缓存）' : ''}`
      : ''
  }
  const sum = $('opsSummary')
  const localBad = (doc.local ?? []).filter((s) => !s.ok).length
  if (sum) {
    const modelOk = doc.model?.hasKey ? '已配置' : '未配置'
    sum.textContent = `远端源 ${remote}/${total} 可用 · 本地产物 ${(doc.local ?? []).length - localBad}/${(doc.local ?? []).length} 就绪 · 模型 ${modelOk}`
    sum.className = remote === total && localBad === 0 ? 'muted' : 'bad'
  }
}

async function loadSources(force = false) {
  const btn = $('srcProbe')
  if (btn) { btn.disabled = true; btn.textContent = force ? '检测中…' : '刷新中…' }
  try {
    const r = force
      ? await fetch('/api/sources/probe', { method: 'POST' })
      : await fetch('/api/sources')
    renderSources(await r.json())
  } catch (e) {
    const tbody = $('srcRows')
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="bad">检测失败：${esc(String(e))}</td></tr>`
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '重新检测' }
  }
}

async function loadModelConfig() {
  try {
    const c = await (await fetch('/api/model/config')).json()
    if ($('mBase')) $('mBase').value = c.baseUrl ?? ''
    if ($('mModel')) $('mModel').value = c.model ?? ''
    if ($('mKey')) {
      $('mKey').value = '' // 绝不回填明文
      $('mKey').placeholder = c.hasKey ? `已保存 ${c.keyMasked}（留空 = 不改）` : '未保存，请输入'
    }
    if ($('mStorePath')) $('mStorePath').textContent = c.storePath ?? '—'
    const meta = $('mMeta')
    if (meta) meta.textContent = c.hasKey ? `已配置（${c.keyMasked}）` : '未配置'
    return c
  } catch {
    return null
  }
}

function setResult(html) {
  const el = $('mResult')
  if (el) el.innerHTML = html
}

async function saveModel(e) {
  e?.preventDefault()
  const body = { baseUrl: $('mBase')?.value ?? '', model: $('mModel')?.value ?? '' }
  const k = $('mKey')?.value ?? ''
  if (k) body.apiKey = k // 留空则不带该字段 = 服务端保持原 Key
  setResult('<span class="muted">保存中…</span>')
  const r = await fetch('/api/model/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  if (!j.ok) return setResult(`<span class="bad">保存失败：${esc(j.error ?? '未知错误')}</span>`)
  if ($('mKey')) $('mKey').value = '' // 提交后立即清空输入框
  await loadModelConfig()
  setResult('<span class="ok">✓ 已保存到服务端</span>')
}

async function testModelConn() {
  const btn = $('mTest')
  if (btn) { btn.disabled = true; btn.textContent = '测试中…' }
  setResult('<span class="muted">正在从服务端发起连通性测试…</span>')
  try {
    const body = { baseUrl: $('mBase')?.value ?? '', model: $('mModel')?.value ?? '' }
    const k = $('mKey')?.value ?? ''
    if (k) body.apiKey = k // 可用未保存的 Key 直接测，不必先保存
    const r = await fetch('/api/model/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await r.json()
    if (j.ok) {
      setResult(
        `<span class="ok">✓ 连通成功</span> · ${esc(j.via)} · HTTP ${j.status} · <b>${j.latencyMs}ms</b>` +
          (j.models?.length ? `<br><span class="muted">可用模型 ${j.models.length} 个：${esc(j.models.slice(0, 6).join(', '))}</span>` : '') +
          (j.reply ? `<br><span class="muted">模型回包：${esc(j.reply)}</span>` : '') +
          `<br><span class="muted">${esc(j.note ?? '')}</span>`,
      )
    } else {
      setResult(
        `<span class="bad">✗ 连通失败</span> · ${esc(j.error ?? '')}` +
          (j.hint ? `<br><span class="warn">${esc(j.hint)}</span>` : '') +
          (j.attempts?.length ? `<pre>${esc(JSON.stringify(j.attempts, null, 2))}</pre>` : ''),
      )
    }
  } catch (e) {
    setResult(`<span class="bad">测试请求失败：${esc(String(e))}</span>`)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '测试连通性' }
  }
}

async function clearModelKey() {
  if (!confirm('确定清除服务端保存的 API Key？')) return
  await fetch('/api/model/key', { method: 'DELETE' })
  await loadModelConfig()
  setResult('<span class="warn">已清除 API Key</span>')
}

let opsLoaded = false
function initOps() {
  if (opsLoaded) return
  opsLoaded = true
  $('opsToggle')?.addEventListener('click', () => {
    const ops = $('ops')
    ops.classList.toggle('collapsed')
    $('opsToggle').textContent = ops.classList.contains('collapsed') ? '展开 ▸' : '收起 ▾'
    syncScrollPolicy()
    if (state.expanded?.tab === 'kline') setTimeout(drawChart, 60) // 画布宽度变了要重画
  })
  $('srcProbe')?.addEventListener('click', () => loadSources(true))
  $('modelForm')?.addEventListener('submit', saveModel)
  $('mTest')?.addEventListener('click', testModelConn)
  $('mClear')?.addEventListener('click', clearModelKey)
}

// ── 交互 ─────────────────────────────────────────────────────────────────
function moveSel(delta) {
  const list = (state.activeBoard === 'gain' ? state.snap?.gainers : state.snap?.losers) ?? []
  if (!list.length) return
  const i = list.findIndex((r) => r.variety === state.expanded?.variety)
  const next = Math.min(Math.max((i < 0 ? -1 : i) + delta, 0), list.length - 1)
  toggleExpand(list[next].variety, state.activeBoard)
}

function focusBoard(kind) {
  state.activeBoard = kind
  if (window.innerWidth <= 1024) {
    $('boardGain').classList.toggle('hide', kind !== 'gain')
    $('boardLoss').classList.toggle('hide', kind !== 'loss')
  }
  $(kind === 'gain' ? 'boardGain' : 'boardLoss').focus()
}

document.addEventListener('keydown', (e) => {
  const typing = document.activeElement === $('search')
  if (e.key === 'Escape') {
    if (typing) { $('search').blur(); $('search').value = ''; state.filter = ''; repaintAll(); return }
    return collapse()
  }
  if (typing) return
  if (e.key === '1') return focusBoard('gain')
  if (e.key === '2') return focusBoard('loss')
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); return moveSel(1) }
  if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); return moveSel(-1) }
  if (e.key === 'Enter') {
    const tr = document.activeElement
    if (tr?.dataset?.variety) toggleExpand(tr.dataset.variety, tr.dataset.kind ?? state.activeBoard)
    return
  }
  if (e.key === '/') { e.preventDefault(); $('search').focus() }
  if (e.key === 'ArrowLeft') return focusBoard('gain')
  if (e.key === 'ArrowRight') return focusBoard('loss')
})

function repaintAll() {
  if (!state.snap) return
  paint('gain', state.snap.gainers, $('bodyGain'))
  paint('loss', state.snap.losers, $('bodyLoss'))
  replantExpandRow()
}

$('search').addEventListener('input', (e) => { state.filter = e.target.value.trim(); repaintAll() })
window.addEventListener('resize', () => { if (state.expanded?.tab === 'kline') drawChart() })

for (const tbody of [$('bodyGain'), $('bodyLoss')]) {
  tbody.innerHTML = Array.from({ length: 20 }, () => `<tr class="skel"><td colspan="10"><span></span></td></tr>`).join('')
}
setInterval(() => {
  if (state.lastMsgAt && Date.now() - state.lastMsgAt > 40000) showBanner('err', '超过 40s 未收到服务端消息，可能连接已中断')
}, 10000)

connect()

// ── 启动：绑定运行状态模块并拉取初始数据（源检测有 60s 缓存，不拖慢首屏）──
initOps()
syncScrollPolicy()
loadSources(false)
loadModelConfig()
