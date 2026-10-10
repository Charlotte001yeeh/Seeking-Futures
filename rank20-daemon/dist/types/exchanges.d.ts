import { type SettleMap } from './types.js';
/** 容错数值解析：剔除千分位、处理空值/'-' */
export declare function num(v: unknown): number;
type Fetcher = (map: SettleMap, d: string, signal?: AbortSignal) => Promise<number>;
/**
 * 各源端点模板（`{d}`=YYYYMMDD，`{y}`=YYYY，`{ym}`=YYYYMM，`{dd}`=DD）。
 * 供状态面板展示与连通性探测使用 —— 与各抓取器里实际拼接的 URL 一一对应。
 */
export declare const EXCHANGE_ENDPOINTS: Record<string, string>;
/** 端点模板 → 实际 URL（供状态面板显示真实地址） */
export declare function expandEndpoint(tpl: string, d: string): string;
/** 交易日候选（最近 n 个工作日，含节假日；节假日抓取会返回空并被跳过） */
export declare function recentWorkdays(n: number, from?: Date): string[];
/** 具名导出各交易所抓取器（供状态面板做**真实**连通性探测，复用同一套解析器） */
export declare const EXCHANGE_FETCHERS: {
    name: string;
    fn: Fetcher;
}[];
/**
 * 抓取最近若干工作日的全交易所数据。
 * @param days 需要的交易日数（建议 ≥ 26，保证能找到 T−20）
 * @param log  日志回调
 * @param signal 取消信号
 * @param from 窗口锚点（"最后一天"，默认今天）。
 *   固定 cutoff 的历史复算**必须**显式传入 cutoff，否则窗口会随真实日期漂移：
 *   32 个工作日的窗口一直在往前挪，某天起就再也盖不住 cutoff 之前的那 21 个交易日，
 *   表现为"品种数=0 / 交易日不足"的假失败（2026-10-10 实测踩到）。
 */
export declare function fetchAllExchanges(days: number, log?: (msg: string) => void, signal?: AbortSignal, from?: Date): Promise<SettleMap>;
export {};
