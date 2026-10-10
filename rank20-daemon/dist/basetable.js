/** 保留多少个交易日的结算价序列（要能覆盖 T−20 并留出滚动余量） */
export const SERIES_DAYS = 30;
/** 契约版本：字段变化必须递增，消费端据此拒绝不兼容的数据 */
export const BASE_SCHEMA_VERSION = 1;
/**
 * 构造基准表 JSON 文本。
 * @param result computeRank20 的结果
 * @param map 全交易所日线（fetchAllExchanges 的输出）
 * @param source 产出者标识（'rank20-daemon' = DSH 插件 / 'standalone-daily-job' = 独立脚本）
 */
export function buildBaseTable(result, map, source = 'rank20-daemon') {
    const dates = Object.keys(map).sort();
    const recent = dates.slice(-SERIES_DAYS);
    const rows = result.all.map((r) => {
        const code = r.contract.toLowerCase();
        const settles = {};
        let lastClose = r.close;
        let lastDate = '';
        let lastOi = 0;
        let lastVol = 0;
        for (const d of recent) {
            const bar = map[d]?.[code];
            if (!bar)
                continue;
            if (Number.isFinite(bar.settle) && bar.settle > 0)
                settles[d] = bar.settle;
            if (Number.isFinite(bar.close) && bar.close > 0) {
                lastClose = bar.close;
                lastDate = d;
                lastOi = Number.isFinite(bar.oi) ? bar.oi : 0;
                lastVol = Number.isFinite(bar.vol) ? bar.vol : 0;
            }
        }
        return {
            variety: r.variety,
            name: r.name,
            contract: r.contract,
            baseSettle: r.baseSettle,
            baseDate: r.baseDate,
            baseVol: r.baseVol,
            close: lastClose,
            lastDate,
            oi: lastOi,
            vol: lastVol,
            isFin: r.isFin,
            isMonthlyAvg: r.isMonthlyAvg,
            settles,
        };
    });
    return JSON.stringify({
        schemaVersion: BASE_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        tradeDate: result.tradeDate,
        baseDate: result.baseDate,
        source,
        diagnostics: result.diagnostics,
        tradingDates: dates,
        seriesDays: SERIES_DAYS,
        rows,
    }, null, 2);
}
//# sourceMappingURL=basetable.js.map