/** 极简 .env 解析（支持 `KEY=value`、`#` 注释、单双引号、行内 `#` 注释） */
export declare function parseEnv(text: string): Record<string, string>;
/** 载入工作区根目录的 .env（只填未设置的变量；文件不存在则跳过） */
export declare function loadEnvFile(file?: string): void;
/** 读一个环境变量（首次调用时会顺带加载 .env） */
export declare function env(name: string, fallback?: string): string;
/** 凭据在官网免费注册后获得：https://www.dce.com.cn/ （数据 → API 服务） */
export interface DceCredentials {
    apiKey: string;
    secret: string;
    host: string;
}
/** DCE API 默认主机（可被 DCE_HOST 覆盖，便于自建代理） */
export declare const DCE_DEFAULT_HOST = "www.dce.com.cn";
/**
 * 取 DCE 凭据。
 * @throws 未配置时抛出**可操作**的错误（含获取方式与 .env 示例），不静默降级。
 */
export declare function dceCredentials(): DceCredentials;
