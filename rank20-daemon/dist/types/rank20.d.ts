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
import { type DayBar, type Rank20Result, type SettleMap } from './types.js';
/** 基准日回看交易日数 */
export declare const BASE_OFFSET = 20;
/**
 * 基准日"有效成交"阈值 —— **已废弃**（2026-09-18 起基准日只按结算价判定）。
 * 保留常量仅为兼容旧调用方，新代码不要使用。
 * @deprecated 见 resolveBase
 */
export declare const MIN_BASE_VOLUME = 1000;
/** 品种分组键：小写品种代码；月均价合约的键为 `<品种>F`（如 ppF） */
export declare function groupKey(contract: string): {
    key: string;
    isF: boolean;
};
/**
 * 主力合约判定（T−1 规则）
 * @param prevBars T−1 日该品种全部合约
 */
export declare function pickMain(prevBars: DayBar[]): string | null;
/** 交易日列表（升序） */
export declare function tradingDates(map: SettleMap): string[];
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
export declare function resolveBase(seq: DayBar[], anchorDate: string): {
    bar: DayBar;
    shifted: boolean;
} | null;
/**
 * 计算 rank20。
 * @param map 全交易所日线数据
 * @param virtualToday 盘中实时用：把日历延伸到「今天」（该日尚无官方日报）。
 *   这样 T 与 T−20 会随交易日一同前移；分子由调用方换成实时最新价。
 *   传入时必须 > map 中最后一个交易日，否则忽略。
 */
export declare function computeRank20(map: SettleMap, virtualToday?: string): Rank20Result;
/**
 * 生成 Markdown 表格。
 *
 * 内容严格限于「涨幅榜 rank20 + 跌幅榜 rank20」两张表（用户要求：
 * 只保存涨跌各 rank20 的品种与数据），不再附加金融期货/月均价/算法规则/诊断等额外段落。
 */
export declare function renderMarkdown(r: Rank20Result): string;
/** 生成 CSV（便于后续处理） */
export declare function renderCsv(r: Rank20Result): string;
