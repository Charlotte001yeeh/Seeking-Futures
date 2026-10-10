/**
 * dsh-rank20-daemon
 *
 * 每日定时抓取六交易所官方行情 → 计算 20 日涨跌幅 rank20 → 输出 Markdown/CSV 到工作区。
 *
 * 算法规范：docs/04-总设计.md §3.5.5、docs/09-20日涨跌幅rank20完整版.md
 * 文件：`YYYY年MM月DD日HH时.md` / `.csv`（只含涨幅榜 rank20 + 跌幅榜 rank20）
 *
 * ── 生命周期约定（本轮重写，解决"热重载要等 95s"的问题）────────────────
 *   · 每个实例持有独立 AbortController，dispose 时 abort
 *   · signal 一路透传：fetch → httpText/httpJson → 重试等待 → 限流等待 → 抓取器 → runOnce/runRealtime
 *   · 所有异步任务都进 inFlight 集合（不再有无人管理的 void Promise）
 *   · ctx.effect 注册异步清理：置 stopping → abort → 清定时器 → 带超时等待在途任务
 *   · dispose 后不再写文件 / 不再 arm 定时器 / 不再更新 baseRows / 不再写"运行完成"日志
 *   · 定时器用原生 setTimeout / clearTimeout（不依赖 timer 服务，fiber 不会因未决定时器停在 loading）
 */
import type { Context } from 'cordis';
import z from 'schemastery';
export { buildBaseTable, SERIES_DAYS } from './basetable.js';
export { stampName, localDay } from './naming.js';
export declare const name = "dsh-rank20-daemon";
/** 不依赖任何服务：定时器用原生实现，避免 fiber 因未决定时器停在 loading */
export declare const inject: string[];
export interface Config {
    /** 每日运行时刻（本地时区小时，0-23） */
    hour: number;
    /** 每日运行时刻（分钟，0-59） */
    minute: number;
    /** 输出目录（绝对路径；留空则用 workspace） */
    outDir: string;
    /** 采集最近多少个工作日（需 ≥ 26 才能覆盖 T−20） */
    lookbackDays: number;
    /**
     * 启动时做**幂等检查**：若当天已成功跑过则跳过；否则按 catchUpOnStart 决定是否补跑。
     * 注意：它**不再**表示"每次挂载都立即抓一次"。
     */
    runOnStart: boolean;
    /**
     * 是否允许在启动/热重载时补跑当日抓取。默认 **false**：
     * 开发期热重载绝不应该触发一次 95s 的历史抓取。需要补跑时显式打开。
     */
    catchUpOnStart: boolean;
    /** 运行日志文件（留空则不落盘） */
    logFile: string;
    /** 当日运行状态文件（幂等判据；留空则用 <dshHome>/super-injector/） */
    stateFile: string;
    /** dispose 时等待在途任务的上限（ms），超时记录错误但不阻塞卸载 */
    cleanupTimeoutMs: number;
    /** 是否开启盘中实时刷新 */
    rtEnabled: boolean;
    /** 盘中刷新间隔（秒）。实测新浪源约 500ms 一拍，间隔 <1s 无意义 */
    rtIntervalSec: number;
    /** 盘中实时榜的文件名（不含扩展名） */
    rtName: string;
    /**
     * 是否由本插件承担**每日日报**的定时任务。
     *
     * 默认 true（插件单独可用）。但本部署里日报已移交**独立调度器**
     * `standalone/scheduler.mjs`（脱离 DSH 运行），因此随源码发布的
     * `cordis.patch.yml` 里显式关掉 —— 否则两个组件会在同一时刻（09:00:00）
     * 各自完整抓一遍六所 32 天数据，并在同一批文件上并发写盘。
     */
    dailyEnabled: boolean;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
/** 供测试引用：判断输出目录里是否已有当日 base.json（不导出则测试需自行实现） */
export declare function baseJsonExists(outDir: string, day?: string): boolean;
