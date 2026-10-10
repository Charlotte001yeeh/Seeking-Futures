import { type DayBar, type SettleMap } from './types.js';
export declare const KLINE_SCHEMA_VERSION = 1;
/** K 线保留的最大根数 */
export declare const KLINE_MAX_BARS = 250;
/** 一根日K */
export interface KBar {
    /** 交易日 YYYYMMDD */
    d: string;
    o: number;
    h: number;
    l: number;
    c: number;
    /** 结算价（CFFEX 无收盘价，c 与 s 相同） */
    s: number;
    v: number;
    oi: number;
    /** 成交额（万元），官方日报有则填 */
    to?: number;
    /** 数据来源：eod=官方日报 | eod_settle_as_close=官方日报(中金所无收盘价) | sina=公开行情接口 */
    src: 'eod' | 'eod_settle_as_close' | 'sina';
    /** 开高低若取自别处（官方缺该字段时的真实回退），在此标明 */
    ohlSrc?: 'sina';
}
export interface KlineFile {
    schemaVersion: number;
    contract: string;
    variety: string;
    name: string;
    updatedAt: string;
    /** 参与合成的来源清单 */
    sources: string[];
    /** 官方日报覆盖的起始交易日（此日期及之后为官方口径） */
    officialFrom: string;
    bars: KBar[];
    rollovers: Array<{
        d: string;
        from: string;
        to: string;
    }>;
}
/** 官方代码 → 新浪日K代码（去掉实时行情的 nf_ 前缀） */
export declare function sinaKlineSymbol(sinaRealtimeSymbol: string): string;
/**
 * 官方合约代码 → 新浪**日K**代码。
 *
 * ⚠️ 与实时行情的 `sinaSymbol()` 关键差别：**月均价 F 合约也支持**
 * （实测 `PP2611F` 81 根、`L2611F` 81 根、`V2610F` 118 根）。
 * 实时行情对 F 合约返回空，所以不能复用那个函数。
 */
export declare function sinaKlineCode(contract: string, now?: Date): string;
/**
 * 抓取新浪期货日K（真实行情数据）。
 * @returns 升序 K 线；失败抛错（由调用方决定是否降级为"仅官方窗口"）
 */
export declare function fetchSinaDailyKline(klineSymbol: string, opts?: {
    signal?: AbortSignal;
    retries?: number;
}): Promise<KBar[]>;
/**
 * 把官方日报窗口与第三方历史合并，**官方优先**。
 * @param official 官方窗口内的日线（来自 SettleMap），key=YYYYMMDD
 * @param sina 第三方历史（升序）
 * @param isFinancial 是否中金所品种（官方无收盘价列）
 */
export declare function mergeKline(official: Map<string, DayBar>, sina: KBar[], isFinancial: boolean): {
    bars: KBar[];
    officialFrom: string;
};
/** 取某合约在官方窗口内的日线 */
export declare function officialBarsFor(map: SettleMap, contract: string): Map<string, DayBar>;
export interface KlineSummary {
    contracts: number;
    bars: number;
    officialOnly: number;
    failed: string[];
    index: Record<string, {
        bars: number;
        first: string;
        last: string;
        officialFrom: string;
    }>;
}
/**
 * 为给定品种（各自的主力合约）刷新日 K 线并落盘。
 *
 * 输出：<outDir>/kline/<合约>.json + <outDir>/kline/index.json
 * 失败处理：单个合约抓取失败 → 只写官方窗口那一段并如实标注，**不伪造历史**。
 */
export declare function refreshKline(outDir: string, rows: Array<{
    variety: string;
    name: string;
    contract: string;
}>, map: SettleMap, opts: {
    log?: (m: string) => void;
    signal?: AbortSignal;
    /** 合约 → 新浪日K代码 */
    symbolOf: (contract: string) => string;
    gapMs?: number;
}): Promise<KlineSummary>;
