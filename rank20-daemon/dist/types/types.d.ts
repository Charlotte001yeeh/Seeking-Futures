/**
 * 公共类型与常量定义。
 */
/** 交易日 K 线数据点（官方日报字段，D3 日K线的最小单元） */
export interface DayBar {
    /** 交易日 YYYYMMDD */
    d: string;
    /** 收盘价 */
    close: number;
    /** 结算价 */
    settle: number;
    /** 成交量 */
    vol: number;
    /** 持仓量 */
    oi: number;
    /** 开盘价（官方日报） */
    open?: number;
    /** 最高价（官方日报） */
    high?: number;
    /** 最低价（官方日报） */
    low?: number;
    /** 成交额（官方日报；单位随交易所，见各解析器注释） */
    turnover?: number;
}
/** SET[date][contract] = DayBar */
export type SettleMap = Record<string, Record<string, DayBar>>;
/** 一个品种的最终一行 */
export interface RankRow {
    /** 品种代码（小写，如 rb / ma；月均价为 ppF / lF / vF） */
    variety: string;
    /** 中文名 */
    name: string;
    /** 主力合约代码 */
    contract: string;
    /** 20 日涨跌幅 % */
    pct: number;
    /** 今日收盘 */
    close: number;
    /** 基准日结算价 */
    baseSettle: number;
    /** 基准日 YYYYMMDD */
    baseDate: string;
    /** 基准日成交量 */
    baseVol: number;
    /** 是否金融期货 */
    isFin: boolean;
    /** 是否月均价期货 */
    isMonthlyAvg: boolean;
    /** 数据源标识 */
    src: string;
}
/** 一次运行的结果 */
export interface Rank20Result {
    /** 运行的交易日 */
    tradeDate: string;
    /** 基准日 */
    baseDate: string;
    /** 运行时点 */
    runAt: string;
    /** 涨幅前 20 */
    gainers: RankRow[];
    /** 跌幅前 20 */
    losers: RankRow[];
    /** 全部品种（降序） */
    all: RankRow[];
    /** 诊断信息 */
    diagnostics: string[];
    /** 可选附注（盘中实时榜用来说明行情时间与换价数量） */
    note?: string;
}
/**
 * 大商所（DCE）官方 API 凭据 —— **不在源码里**。
 *
 * 真实凭据从环境变量 `.env` 读取（见根目录 `.env.example` 与 `env.ts`）：
 * 凭据一旦写进源码并推到 GitHub，就等于公开泄漏，且无法靠"改一行再提交"补救。
 * 取用方式：`import { dceCredentials } from './env.js'`。
 */
export { dceCredentials, DCE_DEFAULT_HOST } from './env.js';
/** 浏览器 UA（部分交易所 WAF 会校验） */
export declare const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
/** 金融期货品种代码（中金所） */
export declare const FINANCIAL: Set<string>;
/** 大商所品种代码（用于识别月均价 F 合约归属） */
export declare const DCE_VARIETIES: Set<string>;
/**
 * 郑商所品种代码。
 *
 * 用途：郑商所官方合约代码用 **3 位月份**（`MA610`），而新浪实时行情要 **4 位**（`MA2610`）。
 * 只有郑商所需要这个补位转换；其余五所官方代码与新浪一致。
 */
export declare const CZCE_VARIETIES: Set<string>;
/** 品种中文名（文华命名口径） */
export declare const NAME: Record<string, string>;
