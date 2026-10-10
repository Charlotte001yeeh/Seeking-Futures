/**
 * 合约代码 → 各源代码 的映射。
 *
 * 六所里只有郑商所需要转换：官方用 **3 位月份**（`MA610`），
 * 而公开实时行情源普遍用 **4 位**（`MA2610`）。
 * 其余五所官方代码与源代码一致。
 */

/** 郑商所品种（docs/10 §1.4） */
export const CZCE_VARIETIES = new Set([
  'ap', 'cf', 'cj', 'cy', 'fg', 'jr', 'ma', 'oi', 'pf', 'pk', 'pl', 'pm',
  'pr', 'px', 'ri', 'rm', 'rs', 'sa', 'sf', 'sh', 'sm', 'sr', 'ta', 'ur',
  'wh', 'zc',
])

/** 月均价合约（DCE `F` 后缀）——公开实时源不提供行情 */
export function isMonthlyAvg(contract) {
  return /f$/i.test(contract)
}

/**
 * 拆解官方合约代码。
 * @returns {{variety:string, digits:string, isF:boolean}|null}
 */
export function parseContract(contract) {
  const m = /^([a-z]{1,2})(\d{3,4})(f?)$/i.exec(String(contract ?? ''))
  if (!m) return null
  return { variety: m[1].toLowerCase(), digits: m[2], isF: (m[3] ?? '').length > 0 }
}

/**
 * 官方代码 → 新浪代码（`nf_XXXX`）。不支持的合约返回 ''。
 */
export function sinaSymbol(contract, now = new Date()) {
  const p = parseContract(contract)
  if (!p || p.isF) return ''
  const upper = p.variety.toUpperCase()
  if (p.digits.length === 3 && CZCE_VARIETIES.has(p.variety)) {
    // X = 年份个位，YZ = 月份 → 补成 4 位年份后两位
    const yearDigit = Number(p.digits[0])
    const month = p.digits.slice(1)
    const thisYear = now.getFullYear()
    let year = Math.floor(thisYear / 10) * 10 + yearDigit
    if (year < thisYear - 2) year += 10
    return `nf_${upper}${String(year).slice(2)}${month}`
  }
  return `nf_${upper}${p.digits}`
}
