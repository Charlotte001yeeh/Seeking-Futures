/**
 * 官方合约代码 → 新浪代码。
 *
 * 郑商所官方是 3 位月份（`MA610` = 2026 年 10 月），新浪要 4 位（`MA2610`）；
 * 其余五所直接用官方代码。月均价合约（`F` 后缀）新浪不提供，返回空串。
 */
export declare function sinaSymbol(contract: string): string;
/** 一条行情：最新价 + 源时间戳 + 交易日 */
export interface LiveQuote {
    /** 最新价 */
    price: number;
    /** 源时间戳 HHMMSS */
    time: string;
    /** 源标注的交易日 YYYY-MM-DD */
    tradeDay: string;
    /** 昨结算 */
    prevSettle: number;
}
/**
 * 批量取最新价。
 * @param contracts 官方合约代码
 * @param opts.timeoutMs 单次请求超时；opts.signal 外部取消信号（实例卸载时 abort）
 * @returns 合约（官方代码，大写）→ 行情；取不到的合约不出现在结果里
 */
export declare function fetchLiveQuotes(contracts: string[], opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<Map<string, LiveQuote>>;
/**
 * 是否在可交易的时段（本地时区）。
 *
 * 商品日盘 09:00–11:30 / 13:30–15:00；夜盘 21:00–次日 02:30（各品种收盘时间不同，
 * 这里给一个宽区间，取不到行情的合约自然会被跳过）。
 * 中金所股指 09:30–11:30 / 13:00–15:00、国债 09:30–11:30 / 13:00–15:15。
 * 取并集做宽松判断，周末直接排除。
 */
export declare function inTradingWindow(now?: Date): boolean;
