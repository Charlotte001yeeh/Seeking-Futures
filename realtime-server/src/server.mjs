/**
 * HTTP + SSE 服务（docs/10 §7 接口清单）。
 *
 * 传输选型说明：
 *   规格把 WebSocket 列为主、SSE 为降级。本实现**直接采用 SSE**，理由：
 *     · 数据流是单向的 服务端 → 浏览器，SSE 语义完全够用（订阅参数走 URL 查询串）
 *     · 零三方依赖（纯 node:http），本地服务不需要构建步骤与 node_modules，长期更稳
 *     · 事件载荷与规格 §7.2 的 JSON 结构逐字段一致，日后要换 WS 只是换传输层
 *   事件名仍沿用 snapshot / hello / heartbeat / sourceHealth / baseDateChange。
 */
import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { config } from './config.mjs'
import { log } from './log.mjs'
import { SERVICE_ROOT } from './config.mjs'
import { KlineStore, applyLiveBar } from './kline.mjs'
import { deriveLogic } from './logic.mjs'
import { probeSources } from './probe.mjs'
import { publicConfig, saveConfig, clearKey, testModel, maskKey } from './modelconfig.mjs'

/** 读取并解析 JSON 请求体（带上限，避免超大 body） */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(s)
}

export function createApp({ poller, hub, baseWatcher }) {
  const startedAt = Date.now()
  const klineStore = new KlineStore()

  /**
   * 品种代码大小写不敏感查找。
   * ⚠️ 必须这样：月均价品种的 variety 是 `ppF`（小写品种 + 大写 F），
   * 而 URL 路径参数经 `.toLowerCase()` 变成 `ppf`，直接全等比较会匹配不上。
   */
  function findByVariety(rows, variety) {
    const k = String(variety ?? '').toLowerCase()
    return (rows ?? []).find((r) => String(r.variety).toLowerCase() === k) ?? null
  }

  /** 本地数据产物状态（基准表 / K 线库）—— 与远端源一起呈现"数据流通性" */
  function localStatus() {
    const b = baseWatcher.table
    const ks = klineStore.stats()
    let klineCount = 0
    try {
      klineCount = readdirSync(ks.dir).filter((f) => f.endsWith('.json') && f !== 'index.json').length
    } catch {
      /* ignore */
    }
    return {
      local: [
        {
          id: 'base',
          name: '基准表 base.json',
          kind: 'local',
          url: config.baseFile,
          ok: !!b,
          detail: b ? `交易日 ${b.tradeDate} · 基准日 ${b.baseDate} · ${b.rows.length} 个品种` : (baseWatcher.lastError ?? '未加载'),
          at: b?.generatedAt ?? null,
        },
        {
          id: 'kline',
          name: '日K线库 kline/',
          kind: 'local',
          url: ks.dir,
          ok: klineCount > 0,
          detail: klineCount > 0 ? `${klineCount} 个合约文件` : '尚未构建',
          at: null,
        },
        {
          id: 'out',
          name: '实时榜产物 盘中实时.md',
          kind: 'local',
          url: join(config.outDir, `${config.rtName}.md`),
          ok: !!hub.current,
          detail: hub.current ? `seq ${hub.current.seq} · 换价 ${hub.current.liveCount}/${hub.current.total}` : '尚无快照',
          at: hub.current?.serverTime ?? null,
        },
      ],
      model: { hasKey: publicConfig().hasKey, keyMasked: publicConfig().keyMasked },
    }
  }

  /** 品种 → 当前主力合约 */
  function contractOf(variety) {
    return findByVariety(baseWatcher.table?.rows, variety)?.contract ?? ''
  }

  /** 取该品种当前快照里的实时报价（用于滚动最后一根 K 线） */
  function liveQuoteFor(variety) {
    const row = findByVariety(hub.current?.all, variety)
    if (!row || !row.is_live) return null
    return {
      tradeDay: hub.current?.tradeDate ?? '',
      open: row.open,
      high: row.high,
      low: row.low,
      price: row.price,
      volume: row.volume,
      oi: row.oi,
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // ── SSE ────────────────────────────────────────────────────────────
    if (path === '/events' || path === '/ws') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      })
      res.write('retry: 3000\n\n')

      const sub = hub.subscribe(
        (payload) => res.write(payload),
        () => res.end(),
      )

      // hello：协议版本 + 当前口径
      const base = baseWatcher.table
      res.write(
        `event: hello\ndata: ${JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          transport: 'sse',
          serverTime: new Date().toISOString(),
          tradeDate: base?.tradeDate ?? '',
          baseDate: base?.baseDate ?? '',
          varieties: base?.rows.length ?? 0,
        })}\n\n`,
      )
      // 立刻给一份当前快照，避免首屏空等
      if (hub.current) res.write(`event: snapshot\ndata: ${JSON.stringify(hub.current)}\n\n`)

      const hb = setInterval(() => {
        try {
          res.write(
            `event: heartbeat\ndata: ${JSON.stringify({
              type: 'heartbeat',
              serverTime: new Date().toISOString(),
              seq: hub.seq,
            })}\n\n`,
          )
        } catch {
          clearInterval(hb)
        }
      }, config.heartbeatMs)

      req.on('close', () => {
        clearInterval(hb)
        hub.remove(sub.id)
      })
      return
    }

    // ── REST ───────────────────────────────────────────────────────────
    if (path === '/api/health') {
      return json(res, 200, {
        ok: true,
        uptimeMs: Date.now() - startedAt,
        poller: poller.stats(),
        base: baseWatcher.table
          ? {
              tradeDate: baseWatcher.table.tradeDate,
              baseDate: baseWatcher.table.baseDate,
              generatedAt: baseWatcher.table.generatedAt,
              varieties: baseWatcher.table.rows.length,
            }
          : null,
        baseError: baseWatcher.lastError,
      })
    }

    if (path === '/api/rank20/latest') {
      const mode = url.searchParams.get('mode') ?? 'realtime'
      if (mode === 'daily') {
        const b = baseWatcher.table
        if (!b) return json(res, 503, { error: 'base 未加载' })
        return json(res, 200, {
          mode: 'daily',
          tradeDate: b.tradeDate,
          baseDate: b.baseDate,
          generatedAt: b.generatedAt,
          rows: b.rows.map((r) => ({
            variety: r.variety,
            name: r.name,
            contract: r.contract,
            base_settle: r.baseSettle,
            base_date: r.baseDate,
            close: r.close,
            source: 'daily_snapshot',
          })),
        })
      }
      if (!hub.current) return json(res, 503, { error: '尚无实时快照' })
      return json(res, 200, hub.current)
    }

    if (path === '/api/meta/varieties') {
      const b = baseWatcher.table
      if (!b) return json(res, 503, { error: 'base 未加载' })
      return json(res, 200, {
        tradeDate: b.tradeDate,
        baseDate: b.baseDate,
        varieties: b.rows.map((r) => ({
          variety: r.variety,
          name: r.name,
          contract: r.contract,
          isFin: r.isFin,
          isMonthlyAvg: r.isMonthlyAvg,
        })),
      })
    }

    // ── 日K线（D3）：真实实现，替换原 501 预留 ─────────────────────────
    const klineRe = /^\/api\/variety\/([a-z0-9]+)\/kline$/i.exec(path)
    if (klineRe) {
      const variety = klineRe[1].toLowerCase()
      const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 120) || 120, 10), 250)
      const contract = contractOf(variety)
      const doc = klineStore.get(contract)
      if (!doc) {
        return json(res, 200, {
          variety,
          contract,
          bars: [],
          sources: [],
          note: 'K 线尚未构建（该合约刚成为主力，或数据源未覆盖）—— 不返回伪造数据',
        })
      }
      // 用实时行情滚动最后一根（官方根不会被覆盖）
      const live = liveQuoteFor(variety)
      const rolled = applyLiveBar(doc, live)
      const bars = rolled.bars.slice(-days)
      const srcCount = {}
      for (const b of bars) srcCount[b.src] = (srcCount[b.src] ?? 0) + 1
      return json(res, 200, {
        variety,
        name: doc.name,
        contract: doc.contract,
        mode: 'contract',
        updatedAt: doc.updatedAt,
        officialFrom: doc.officialFrom,
        sources: doc.sources,
        sourceBreakdown: srcCount,
        liveBarDate: rolled.liveBarDate ?? null,
        isLive: !!live,
        bars,
        rollovers: doc.rollovers ?? [],
        refDate: baseWatcher.table?.rows?.find((r) => r.variety === variety)?.baseDate ?? null,
        note: '同一天官方日报数据永远覆盖第三方；每根的 src 标注来源，可逐根复核',
      })
    }

    // ── 硬逻辑（规则推导 v1，**非模型**；每条附真实数据证据）───────────
    const logicRe = /^\/api\/variety\/([a-z0-9]+)\/logic$/i.exec(path)
    if (logicRe) {
      const variety = logicRe[1].toLowerCase()
      const rows = hub.current?.all ?? []
      const row = findByVariety(rows, variety)
      if (!row) return json(res, 404, { error: 'not_found', variety, note: '该品种当前不在榜单中' })
      const doc = klineStore.get(row.contract)
      const live = liveQuoteFor(variety)
      const rolled = doc ? applyLiveBar(doc, live) : null
      return json(res, 200, deriveLogic(row, rows, rolled))
    }

    // ── 数据源状态面板 ──────────────────────────────────────────────────
    if (path === '/api/sources') {
      const tradeDate = baseWatcher.table?.tradeDate ?? ''
      const probe = await probeSources({ tradeDate })
      return json(res, 200, { ...probe, ...localStatus() })
    }
    if (path === '/api/sources/probe' && req.method === 'POST') {
      const tradeDate = baseWatcher.table?.tradeDate ?? ''
      const probe = await probeSources({ force: true, tradeDate })
      return json(res, 200, { ...probe, ...localStatus() })
    }

    // ── 模型 API 配置（密钥只在服务端，绝不明文回传）───────────────────
    if (path === '/api/model/config') {
      if (req.method === 'GET') return json(res, 200, publicConfig())
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const r = saveConfig(body ?? {})
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, config: r.config } : { ok: false, error: r.error })
      }
      return json(res, 405, { error: 'method_not_allowed' })
    }
    if (path === '/api/model/test' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const r = await testModel(body ?? {})
      log.info(`模型连通性测试：${r.ok ? '成功' : '失败'}（${r.via ?? r.error}${r.latencyMs ? ` ${r.latencyMs}ms` : ''}）`)
      return json(res, 200, r)
    }
    if (path === '/api/model/key' && req.method === 'DELETE') {
      return json(res, 200, { ok: true, config: clearKey() })
    }

    if (path === '/api/reconcile/latest') {
      return json(res, 200, { checks: [], note: '对账闭环（R5）尚未实现，见 docs/10 §3.5' })
    }

    // ── 静态资源 ───────────────────────────────────────────────────────
    const rel = path === '/' ? '/index.html' : path
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '')
    const file = join(config.webDir, safe)
    if (!file.startsWith(config.webDir)) return json(res, 403, { error: 'forbidden' })
    try {
      const st = await stat(file)
      if (!st.isFile()) throw new Error('not a file')
      const body = await readFile(file)
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      })
      res.end(body)
    } catch {
      json(res, 404, { error: 'not found', path })
    }
  })

  return server
}

export function startServer({ poller, hub, baseWatcher }) {
  const server = createApp({ poller, hub, baseWatcher })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      const addr = server.address()
      log.info(`realtime-server 监听 http://${config.host}:${addr.port}  （服务根目录 ${SERVICE_ROOT}）`)
      resolve(server)
    })
  })
}
