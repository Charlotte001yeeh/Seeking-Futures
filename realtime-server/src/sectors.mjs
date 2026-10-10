/**
 * 板块分类（**项目内置分类表**，非官方数据）
 *
 * 说明：等级/题材归属没有官方接口，这里维护一份可审计的分类表，
 * 仅用于「板块共振」「龙头判定」这类**相对比较**，不参与任何数值计算。
 * 前端会明确标注分类来自本项目内置表，而不是交易所或行情源。
 */
export const SECTORS = {
  能源化工: [
    'sc', 'bu', 'fu', 'lu', 'pg', 'ta', 'eg', 'ma', 'pp', 'l', 'v', 'eb', 'px',
    'pf', 'pr', 'sh', 'sa', 'fg', 'ur', 'ru', 'br', 'nr', 'sp', 'bz', 'pl', 'bc',
  ],
  黑色建材: ['rb', 'hc', 'ss', 'wr', 'i', 'j', 'jm', 'sf', 'sm'],
  有色金属: ['cu', 'al', 'zn', 'pb', 'ni', 'sn', 'ao', 'ad', 'si', 'ps', 'lc', 'au', 'ag', 'pt', 'pd'],
  农产品: [
    'm', 'y', 'p', 'a', 'b', 'c', 'cs', 'jd', 'lh', 'rr', 'cf', 'cy', 'sr', 'oi',
    'rm', 'rs', 'ap', 'cj', 'pk', 'fb', 'bb', 'lg', 'wh', 'pm', 'ri', 'jr', 'lr', 'zc',
  ],
  航运: ['ec'],
  金融: ['if', 'ic', 'ih', 'im', 't', 'tf', 'ts', 'tl'],
}

/** 品种代码（去掉月均价 F 后缀）→ 板块 */
const BY_VARIETY = new Map()
for (const [sector, list] of Object.entries(SECTORS)) {
  for (const v of list) BY_VARIETY.set(v, sector)
}

export function sectorOf(variety) {
  return BY_VARIETY.get(String(variety ?? '').replace(/F$/, '').toLowerCase()) ?? '未分类'
}

/** 月均价合约的板块归属其标的品种（ppF → 能源化工） */
export function sectorOfRow(row) {
  return sectorOf(row.variety)
}
