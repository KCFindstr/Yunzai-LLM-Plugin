/**
 * Calendar days for the recall archive, in China time (UTC+8, same as the usage ledger's daily buckets),
 * plus parsing of relative date phrases ("昨天", "上周六", "10月20日") into day ranges.
 */

const TZ_OFFSET = 8 * 3600_000
const DAY = 86400_000

/** "YYYY-MM-DD" of a timestamp in UTC+8. */
export function localDay(ts = Date.now()): string {
  return new Date(ts + TZ_OFFSET).toISOString().slice(0, 10)
}

/** Day string shifted by n days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
}

/** 0 = Monday … 6 = Sunday. */
function weekday(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
}

const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const WEEKDAY: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }

/** "3" / "十二" / "二十" -> number (small Chinese numerals only). */
function num(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '十') return 10
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s)
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0)
  return s.length === 1 ? CN_DIGIT[s] : undefined
}

function valid(y: number, m: number, d: number): string | undefined {
  const day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && addDays(day, 0) === day ? day : undefined
}

export interface DayRange { from: string; to: string }

/**
 * First date phrase in `text` as an inclusive day range, or undefined. Bare weekdays and month-days
 * refer to the most recent past occurrence (a conversation archive has no future).
 */
export function parseDateHints(text: string, now = Date.now()): DayRange | undefined {
  const today = localDay(now)
  // future references ("下周一", "明天") must not fall through to the bare-weekday / bare-day rules
  text = text.replace(/下下?(?:个)?(?:周末|周|星期|礼拜|月)[一二三四五六日天]?|大?后天|明天|明日|明晚/g, ' ')
  const one =(day: string | undefined): DayRange | undefined => (day && day <= today ? { from: day, to: day } : undefined)
  let m: RegExpExecArray | null

  if ((m = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})[日号]?/.exec(text))) return one(valid(+m[1], +m[2], +m[3]))
  if ((m = /(\d{1,2}|[一二三四五六七八九十]{1,3})月(\d{1,2}|[一二三四五六七八九十]{1,3})[日号]/.exec(text))) {
    const mo = num(m[1]), d = num(m[2])
    if (mo == null || d == null) return undefined
    const y = +today.slice(0, 4)
    const day = valid(y, mo, d)
    return one(day && day > today ? valid(y - 1, mo, d) : day)
  }
  if (/大前天/.test(text)) return one(addDays(today, -3))
  if (/前天/.test(text)) return one(addDays(today, -2))
  if (/昨天|昨日|昨晚|昨儿/.test(text)) return one(addDays(today, -1))
  if (/今天|今日|今晚|今早|今儿/.test(text)) return one(today)
  if ((m = /(\d{1,2}|[一二两三四五六七八九十]{1,3})天(?:以)?前/.exec(text))) {
    const n = num(m[1])
    if (n != null && n <= 366) return one(addDays(today, -n))
  }

  const monday = addDays(today, -weekday(today))
  if ((m = /(上上|上|这|本)?(?:个)?周末/.exec(text))) {
    // bare "周末" on a weekday means the weekend just past
    const weeks = m[1] === '上上' ? -2 : m[1] === '上' ? -1 : m[1] ? 0 : weekday(today) >= 5 ? 0 : -1
    const sat = addDays(monday, 5 + weeks * 7)
    const sun = addDays(sat, 1)
    if (sat > today) return undefined
    return { from: sat, to: sun > today ? today : sun }
  }
  if ((m = /(上上|上|这|本)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(text))) {
    const target = WEEKDAY[m[2]]
    const base = m[1] === '上上' ? addDays(monday, -14) : m[1] === '上' ? addDays(monday, -7) : monday
    let day = addDays(base, target)
    // bare "周六" said on a Wednesday means last Saturday
    if (!m[1] && day > today) day = addDays(day, -7)
    return one(day)
  }
  if ((m = /(上上|上|这|本)(?:个)?(?:周|星期|礼拜)(?![一二三四五六日天])/.exec(text))) {
    if (m[1] === '这' || m[1] === '本') return { from: monday, to: today }
    const start = addDays(monday, m[1] === '上上' ? -14 : -7)
    return { from: start, to: addDays(start, 6) }
  }
  if ((m = /(上|这|本)(?:个)?月(?![\d一二三四五六七八九十]+[日号])/.exec(text))) {
    const first = `${today.slice(0, 7)}-01`
    if (m[1] !== '上') return { from: first, to: today }
    const prevFirst = `${addDays(first, -1).slice(0, 7)}-01`
    return { from: prevFirst, to: addDays(first, -1) }
  }
  if ((m = /(?:最近|近|过去)(\d{1,2}|[一二两三四五六七八九十]{1,3})天/.exec(text))) {
    const n = num(m[1])
    if (n != null && n >= 1 && n <= 366) return { from: addDays(today, -(n - 1)), to: today }
  }
  return undefined
}
