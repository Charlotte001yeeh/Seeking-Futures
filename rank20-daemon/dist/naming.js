/**
 * 文件命名与本地日期（零依赖）
 *
 * 单独成模块的原因：这两个函数既被 DSH 插件外壳用，也被**脱离 DSH 的独立脚本**用；
 * 而插件外壳（index.ts）import 了 schemastery，独立脚本不能依赖它。
 */
/**
 * 输出文件基名：`YYYY年MM月DD日HH时`（本地时区的**生成时刻**）。
 * 例：2026年09月17日09时.md
 */
export function stampName(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}年${p(d.getMonth() + 1)}月${p(d.getDate())}日${p(d.getHours())}时`;
}
/** 本地日期键 YYYY-MM-DD（幂等判据按**本地**日算，与 09:00 调度同一时区） */
export function localDay(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
//# sourceMappingURL=naming.js.map