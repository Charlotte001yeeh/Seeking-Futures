/**
 * 基准表构造（零依赖）
 *
 * `base.json` 是**数据生产端**与**实时服务端**之间的单向契约：
 *   · rows[].settles           主力合约最近 N 个交易日的结算价（供实时端把 T−20 随交易日滚动）
 *   · rows[].baseSettle/baseDate  当日官方口径的基准（权威值）
 *   · tradingDates             交易日历（实时端判断"今天"是否是新交易日）
 *   · rows[].oi / vol          最近一个真实交易日的持仓量与成交量（供实时端算持仓变化 D2）
 *
 * 单独成模块的原因：DSH 插件外壳（index.ts）与**脱离 DSH 的独立每日任务**
 * （standalone/daily-job.mjs）都要用它；外壳 import 了 schemastery，独立脚本不能依赖。
 */
import type { Rank20Result, SettleMap } from './types.js';
/** 保留多少个交易日的结算价序列（要能覆盖 T−20 并留出滚动余量） */
export declare const SERIES_DAYS = 30;
/** 契约版本：字段变化必须递增，消费端据此拒绝不兼容的数据 */
export declare const BASE_SCHEMA_VERSION = 1;
/**
 * 构造基准表 JSON 文本。
 * @param result computeRank20 的结果
 * @param map 全交易所日线（fetchAllExchanges 的输出）
 * @param source 产出者标识（'rank20-daemon' = DSH 插件 / 'standalone-daily-job' = 独立脚本）
 */
export declare function buildBaseTable(result: Rank20Result, map: SettleMap, source?: string): string;
