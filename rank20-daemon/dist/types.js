/**
 * 公共类型与常量定义。
 */
/**
 * 大商所（DCE）官方 API 凭据 —— **不在源码里**。
 *
 * 真实凭据从环境变量 `.env` 读取（见根目录 `.env.example` 与 `env.ts`）：
 * 凭据一旦写进源码并推到 GitHub，就等于公开泄漏，且无法靠"改一行再提交"补救。
 * 取用方式：`import { dceCredentials } from './env.js'`。
 */
export { dceCredentials, DCE_DEFAULT_HOST } from './env.js';
/** 浏览器 UA（部分交易所 WAF 会校验） */
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
/** 金融期货品种代码（中金所） */
export const FINANCIAL = new Set(['if', 'ic', 'ih', 'im', 't', 'tf', 'ts', 'tl']);
/** 大商所品种代码（用于识别月均价 F 合约归属） */
export const DCE_VARIETIES = new Set([
    'i', 'j', 'jm', 'm', 'y', 'p', 'c', 'cs', 'a', 'b', 'jd', 'lh',
    'eg', 'eb', 'pg', 'l', 'v', 'pp', 'rr', 'lg', 'bz', 'fb', 'bb',
]);
/**
 * 郑商所品种代码。
 *
 * 用途：郑商所官方合约代码用 **3 位月份**（`MA610`），而新浪实时行情要 **4 位**（`MA2610`）。
 * 只有郑商所需要这个补位转换；其余五所官方代码与新浪一致。
 */
export const CZCE_VARIETIES = new Set([
    'ap', 'cf', 'cj', 'cy', 'fg', 'jr', 'ma', 'oi', 'pf', 'pk', 'pl', 'pm',
    'pr', 'px', 'ri', 'rm', 'rs', 'sa', 'sf', 'sh', 'sm', 'sr', 'ta', 'ur',
    'wh', 'zc',
]);
/** 品种中文名（文华命名口径） */
export const NAME = {
    rb: '螺纹钢', wr: '线材', hc: '热轧卷板', ss: '不锈钢',
    cu: '沪铜', al: '沪铝', zn: '沪锌', pb: '沪铅', ni: '沪镍', sn: '沪锡',
    au: '沪金', ag: '沪银', ao: '氧化铝', ad: '铸造铝合金',
    br: '丁二烯橡胶', bu: '沥青', fu: '燃料油', lu: '低硫燃料油',
    sp: '纸浆', ru: '橡胶', nr: '20号胶', sc: '原油', bc: '国际铜',
    ec: '集运指数(欧线)', op: '胶版印刷纸',
    ta: 'PTA', ma: '甲醇', fg: '玻璃', sa: '纯碱', ur: '尿素', pf: '短纤',
    px: '对二甲苯', sh: '烧碱', sr: '白糖', cf: '棉花', cy: '棉纱',
    ap: '苹果', cj: '红枣', pk: '花生', rm: '菜粕', oi: '菜油', rs: '菜籽',
    sm: '锰硅', sf: '硅铁', pr: '瓶片', pl: '丙烯',
    zc: '动力煤', jr: '粳稻', ri: '早籼稻', lr: '晚籼稻', pm: '普麦', wh: '强麦',
    i: '铁矿石', j: '焦炭', jm: '焦煤', m: '豆粕', y: '豆油', p: '棕榈油',
    c: '玉米', cs: '玉米淀粉', a: '豆一', b: '豆二', jd: '鸡蛋', lh: '生猪',
    eg: '乙二醇', eb: '苯乙烯', pg: '液化石油气', l: '聚乙烯', v: '聚氯乙烯',
    pp: '聚丙烯', rr: '粳米', lg: '原木', bz: '纯苯', fb: '纤维板', bb: '胶合板',
    si: '工业硅', ps: '多晶硅', lc: '碳酸锂', pd: '钯', pt: '铂',
    if: '沪深300', ic: '中证500', ih: '上证50', im: '中证1000',
    t: '10年期国债', tf: '5年期国债', ts: '2年期国债', tl: '30年期国债',
};
//# sourceMappingURL=types.js.map