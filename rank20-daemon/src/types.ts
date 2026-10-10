/**
 * 公共类型与常量定义。
 */

/** 交易日 K 线数据点（官方日报字段，D3 日K线的最小单元） */
export interface DayBar {
  /** 交易日 YYYYMMDD */
  d: string
  /** 收盘价 */
  close: number
  /** 结算价 */
  settle: number
  /** 成交量 */
  vol: number
  /** 持仓量 */
  oi: number
  /** 开盘价（官方日报） */
  open?: number
  /** 最高价（官方日报） */
  high?: number
  /** 最低价（官方日报） */
  low?: number
  /** 成交额（官方日报；单位随交易所，见各解析器注释） */
  turnover?: number
}

/** SET[date][contract] = DayBar */
export type SettleMap = Record<string, Record<string, DayBar>>

/** 一个品种的最终一行 */
export interface RankRow {
  /** 品种代码（小写，如 rb / ma；月均价为 ppF / lF / vF） */
  variety: string
  /** 中文名 */
  name: string
  /** 主力合约代码 */
  contract: string
  /** 20 日涨跌幅 % */
  pct: number
  /** 今日收盘 */
  close: number
  /** 基准日结算价 */
  baseSettle: number
  /** 基准日 YYYYMMDD */
  baseDate: string
  /** 基准日成交量 */
  baseVol: number
  /** 是否金融期货 */
  isFin: boolean
  /** 是否月均价期货 */
  isMonthlyAvg: boolean
  /** 数据源标识 */
  src: string
}

/** 一次运行的结果 */
export interface Rank20Result {
  /** 运行的交易日 */
  tradeDate: string
  /** 基准日 */
  baseDate: string
  /** 运行时点 */
  runAt: string
  /** 涨幅前 20 */
  gainers: RankRow[]
  /** 跌幅前 20 */
  losers: RankRow[]
  /** 全部品种（降序） */
  all: RankRow[]
  /** 诊断信息 */
  diagnostics: string[]
  /** 可选附注（盘中实时榜用来说明行情时间与换价数量） */
  note?: string
}

/**
 * 大商所（DCE）官方 API 凭据 —— **不在源码里**。
 *
 * 真实凭据从环境变量 `.env` 读取（见根目录 `.env.example` 与 `env.ts`）：
 * 凭据一旦写进源码并推到 GitHub，就等于公开泄漏，且无法靠"改一行再提交"补救。
 * 取用方式：`import { dceCredentials } from './env.js'`。
 */
export { dceCredentials, DCE_DEFAULT_HOST } from './env.js'

/** 浏览器 UA（部分交易所 WAF 会校验） */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 金融期货品种代码（中金所） */
export const FINANCIAL = new Set(['if', 'ic', 'ih', 'im', 't', 'tf', 'ts', 'tl'])

/** 大商所品种代码（用于识别月均价 F 合约归属） */
export const DCE_VARIETIES = new Set([
  'i', 'j', 'jm', 'm', 'y', 'p', 'c', 'cs', 'a', 'b', 'jd', 'lh',
  'eg', 'eb', 'pg', 'l', 'v', 'pp', 'rr', 'lg', 'bz', 'fb', 'bb',
])

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
])

/** 品种中文名（文华命名口径） */
export const NAME: Record<string, string> = {
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
}
