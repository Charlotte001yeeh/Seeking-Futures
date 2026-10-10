/** 取消（正常卸载）专用错误：调用方据此区分"业务失败"与"实例已停止" */
export declare class CancelledError extends Error {
    constructor(message?: string);
}
/** 判定一个异常是否为取消引起（含 undici 抛出的 AbortError） */
export declare function isCancelled(e: unknown): boolean;
/** 可取消的 sleep */
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
export interface FetchOptions {
    method?: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
    /** 最大尝试次数（含首次） */
    retries?: number;
    /** 单次尝试超时 ms */
    timeoutMs?: number;
    /** 外部取消信号（插件实例的 AbortController） */
    signal?: AbortSignal;
}
/** 统一抓取：限流 → 请求 → 重试 → 返回文本 */
export declare function httpText(url: string, opt?: FetchOptions): Promise<string>;
/** 抓取并解析 JSON */
export declare function httpJson<T = unknown>(url: string, opt?: FetchOptions): Promise<T>;
