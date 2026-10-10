/**
 * rank20 计算模块 —— 算法规范见 docs/04-总设计.md §3.5.5 / docs/09
 *
 * 公式：20日涨跌幅 = (今日收盘价 − 基准日结算价) / 基准日结算价 × 100
 *
 * 规则：
 *   R1 分子 = 今日收盘价（盘中运行即最新价）
 *   R2 分母 = 基准日结算价；基准日 = T−20（第 20 个交易日之前）
 *   R3 基准日按**结算价**判定：T−20 有结算价就用它；完全没有才回退到最近有结算价的交易日
 *   R4 主力合约 = T−1 日成交量最大者
 *   R5 跨换月不拼接：用当前主力合约自身的价格序列
 *   R6 包含 DCE 月均价期货（F 后缀）
 *   R7 商品与金融期货混合排名
 */
import {
  DCE_VARIETIES,
  FINANCIAL,
  NAME,
  type DayBar,
  type RankRow,
  type Rank20Result,
  type SettleMap,
} from './types.js'

/** 基准日回看交易日数 */
export const BASE_OFFSET = 20

/**
 * 基准日"有效成交"阈值 —— **已废弃**（2026-09-18 起基准日只按结算价判定）。
 * 保留常量仅为兼容旧调用方，新代码不要使用。
 * @deprecated 见 resolveBase
 */
export const MIN_BASE_VOLUME = 1000

/** 品种分组键：小写品种代码；月均价合约的键为 `<品种>F`（如 ppF） */
export function groupKey(contract: string): { key: string; isF: boolean } {
  const m = /^([a-z]{1,2})(\d{3,4})(f?)$/i.exec(contract)
  if (!m) return { key: contract.toLowerCase(), isF: false }
  const pg = m[1]!.toLowerCase()
  const isF = (m[3] ?? '').length > 0 && DCE_VARIETIES.has(pg)
  return { key: isF ? `${pg}F` : pg, isF }
}

/**
 * 主力合约判定（T−1 规则）
 * @param prevBars T−1 日该品种全部合约
 */
export function pickMain(prevBars: DayBar[]): string | null {
  const byVol = prevBars.filter((b) => b.vol > 0).sort((a, b) => b.vol - a.vol)
  if (byVol.length > 0) return byVol[0]!.d // 占位，由调用方替换为合约号
  return null
}

/** 交易日列表（升序） */
export function tradingDates(map: SettleMap): string[] {
  return Object.keys(map).sort()
}

/**
 * 基准日取值（用户 2026-09-18 定标：**只看结算价，与成交量无关**）。
 *
 *   1. T−20 当天该合约**有结算价** → 直接用它（哪怕当天零成交）
 *   2. T−20 当天**完全没有结算价**（该合约当日无数据，CZCE 不发布未成交合约）
 *      → 逐日向前回退，取最近一个有结算价的交易日
 *   3. 整个区间都没有 → 返回 null（该品种跳过）
 *
 * 历史说明：早期版本用「T−20 成交 < 1000 手就前移一天」的成交量阈值规则，
 * 那是靠 9-16 榜的菜籽/胶合板反推出来的近似；它在铂 PT2612 上偏差达 4.3 个百分点
 * （08-20 结算 444.9 → −1.51% vs 08-19 结算 426.2 → +2.82%），已废弃。
 *
 * @param seq 该合约的日线序列（升序）
 * @param anchorDate 基准日（T−20）
 */
export function resolveBase(
  seq: DayBar[],
  anchorDate: string,
): { bar: DayBar; shifted: boolean } | null {
  const ok = (b: DayBar | undefined): b is DayBar =>
    !!b && Number.isFinite(b.settle) && b.settle > 0

  // 1) T−20 当天有结算价 → 直接用
  const on = seq.find((b) => b.d === anchorDate)
  if (ok(on)) return { bar: on, shifted: false }

  // 2) 逐日向前回退，取最近一个有结算价的交易日
  const before = seq
    .filter((b) => b.d < anchorDate && ok(b))
    .sort((a, b) => (a.d < b.d ? -1 : 1))
  const last = before[before.length - 1]
  return last ? { bar: last, shifted: true } : null
}

/**
 * 计算 rank20。
 * @param map 全交易所日线数据
 * @param virtualToday 盘中实时用：把日历延伸到「今天」（该日尚无官方日报）。
 *   这样 T 与 T−20 会随交易日一同前移；分子由调用方换成实时最新价。
 *   传入时必须 > map 中最后一个交易日，否则忽略。
 */
export function computeRank20(map: SettleMap, virtualToday?: string): Rank20Result {
  const diagnostics: string[] = []
  const dates = tradingDates(map)
  const calendar =
    virtualToday && virtualToday > (dates[dates.length - 1] ?? '') ? [...dates, virtualToday] : dates
  if (calendar.length < BASE_OFFSET + 1) {
    return {
      tradeDate: calendar[calendar.length - 1] ?? '',
      baseDate: '',
      runAt: new Date().toISOString(),
      gainers: [], losers: [], all: [],
      diagnostics: [`交易日不足（仅 ${calendar.length} 个），至少需要 ${BASE_OFFSET + 1} 个`],
    }
  }

  const tradeDate = calendar[calendar.length - 1]!
  const prevDate = calendar[calendar.length - 2]!
  const anchorDate = calendar[calendar.length - 1 - BASE_OFFSET]!
  /** 是否处在「虚拟今日」（今天还没出官方日报，只能拿实时价当分子） */
  const virtual = virtualToday === tradeDate && !map[tradeDate]

  // 按品种分组：group[pg][contract] = DayBar[]（升序）
  const group: Record<string, Record<string, DayBar[]>> = {}
  for (const d of dates) {
    for (const [contract, bar] of Object.entries(map[d] ?? {})) {
      const { key } = groupKey(contract)
      const g = (group[key] ??= {})
      ;(g[contract] ??= []).push(bar)
    }
  }

  const rows: RankRow[] = []

  for (const [key, contracts] of Object.entries(group)) {
    const isMonthlyAvg = key.endsWith('F')
    const pg = isMonthlyAvg ? key.slice(0, -1) : key

    // ── R4：主力 = T−1 日成交量最大者
    //
    // ⚠️ 附加约束：该合约必须在基准日（T−20）**有结算价**。
    //    刚挂牌的新合约没有 20 日历史，算不出 20 日涨跌幅，不能当主力 —— 否则该品种
    //    会因为"新主力算不出来"而整品种从榜单里消失（实测：菜籽在 09-18 交易日
    //    T−1=09-17 时量最大的是新挂牌的 rs701，而 rs701 在 08-21 还没有行情）。
    //    这里改为在"有基准价的合约"中取 T−1 量最大者，保证品种不丢。
    const hasBase = (seq: DayBar[]): boolean => resolveBase(seq, anchorDate) !== null

    let mainContract: string | null = null
    let bestVol = -1
    for (const [contract, seq] of Object.entries(contracts)) {
      const v = seq.find((b) => b.d === prevDate)?.vol ?? 0
      if (v <= bestVol) continue
      if (!hasBase(seq)) continue
      bestVol = v
      mainContract = contract
    }
    if (!mainContract || bestVol <= 0) {
      // T−1 无量：退化为当日成交量最大（同样要求有基准价）
      let best = -1
      let pick: string | null = null
      for (const [contract, seq] of Object.entries(contracts)) {
        const v = seq.find((b) => b.d === tradeDate)?.vol ?? 0
        if (v <= best) continue
        if (!hasBase(seq)) continue
        best = v
        pick = contract
      }
      if (pick) { mainContract = pick; bestVol = best }
    }
    if (!mainContract) {
      diagnostics.push(`${key}: 无任何合约在基准日(${anchorDate})有结算价，整体跳过`)
      continue
    }

    const seq = contracts[mainContract]!
    // 虚拟今日（盘中）：该合约今日还没有日报，取最近一根真实K线作为价格参照，
    // 实际价格由调用方用实时最新价替换。
    const today = virtual
      ? [...seq].filter((b) => b.d <= prevDate).pop()
      : seq.find((b) => b.d === tradeDate)
    if (!today || !Number.isFinite(today.close) || today.close === 0) continue
    if (!virtual && today.vol <= 0) continue

    // ── R2/R3：基准日取值（只按结算价，与成交量无关）
    const base = resolveBase(seq, anchorDate)
    if (!base) {
      diagnostics.push(`${key}/${mainContract}: 基准日(${anchorDate})及之前均无结算价，跳过`)
      continue
    }

    const pct = ((today.close - base.bar.settle) / base.bar.settle) * 100
    const src = isMonthlyAvg
      ? 'DCE月均价'
      : FINANCIAL.has(pg)
        ? 'CFFEX'
        : DCE_VARIETIES.has(pg) && /^[a-z]{1,2}\d{4}$/.test(mainContract)
          ? 'DCE'
          : '交易所官方'

    rows.push({
      variety: key,
      name: (NAME[pg] ?? pg.toUpperCase()) + (isMonthlyAvg ? '月均价' : ''),
      contract: mainContract.toUpperCase(),
      pct,
      close: today.close,
      baseSettle: base.bar.settle,
      baseDate: base.bar.d,
      baseVol: base.bar.vol,
      isFin: !isMonthlyAvg && FINANCIAL.has(pg),
      isMonthlyAvg,
      src,
    })
  }

  // ── R7：商品与金融混合，按涨跌幅降序
  rows.sort((a, b) => b.pct - a.pct)

  const shifted = rows.filter((r) => r.baseDate !== anchorDate)
  if (shifted.length > 0) {
    diagnostics.push(
      `基准日例外（T−20 无成交，前移）${shifted.length} 个：` +
        shifted.map((r) => `${r.name}→${r.baseDate}`).join('、'),
    )
  }

  return {
    tradeDate,
    baseDate: anchorDate,
    runAt: new Date().toISOString(),
    gainers: rows.slice(0, 20),
    losers: rows.slice(-20).reverse(),
    all: rows,
    diagnostics,
  }
}

/**
 * 生成 Markdown 表格。
 *
 * 内容严格限于「涨幅榜 rank20 + 跌幅榜 rank20」两张表（用户要求：
 * 只保存涨跌各 rank20 的品种与数据），不再附加金融期货/月均价/算法规则/诊断等额外段落。
 */
export function renderMarkdown(r: Rank20Result): string {
  const row = (i: number, x: RankRow): string =>
    `| ${i + 1} | **${x.name}** | ${x.contract} | **${x.pct >= 0 ? '+' : ''}${x.pct.toFixed(2)}%** | ${x.close} | ${x.baseSettle} | ${x.baseDate}${x.baseDate !== r.baseDate ? ' ⚠️前移' : ''} |`

  const head =
    '| 排名 | 品种 | 主力合约 | 20日涨跌% | 今收盘 | 基准结算 | 基准日 |\n' +
    '| ---: | --- | --- | ---: | ---: | ---: | --- |'

  return [
    `# 期货 20 日涨跌幅 rank20`,
    '',
    `> 交易日 **${r.tradeDate}** · 基准日 **${r.baseDate}** · 生成 ${r.runAt.slice(0, 16).replace('T', ' ')}`,
    `> 公式：\`(今日收盘 − 基准日结算价) / 基准日结算价 × 100\``,
    ...(r.note ? [`> ${r.note}`] : []),
    '',
    '## 【涨幅榜 rank20】',
    '',
    head,
    ...r.gainers.map((x, i) => row(i, x)),
    '',
    '## 【跌幅榜 rank20】',
    '',
    head,
    ...r.losers.map((x, i) => row(i, x)),
    '',
  ].join('\n')
}

/** 生成 CSV（便于后续处理） */
export function renderCsv(r: Rank20Result): string {
  const head = 'rank,direction,variety,name,contract,pct_20d,close,base_settle,base_date,is_fin,is_monthly_avg,src'
  const line = (i: number, dir: string, x: RankRow): string =>
    [i + 1, dir, x.variety, x.name, x.contract, x.pct.toFixed(4), x.close, x.baseSettle, x.baseDate, x.isFin ? 1 : 0, x.isMonthlyAvg ? 1 : 0, x.src]
      .map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v))
      .join(',')
  return [
    head,
    ...r.gainers.map((x, i) => line(i, 'gain', x)),
    ...r.losers.map((x, i) => line(i, 'loss', x)),
  ].join('\n')
}
