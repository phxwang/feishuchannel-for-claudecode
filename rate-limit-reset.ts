/**
 * Parses the reset time out of Claude Code's rate_limit message text, e.g.
 * "You've hit your session limit · resets 9:30pm (Asia/Singapore)".
 *
 * The timezone Claude reports is already an IANA identifier, so `Intl` can
 * convert the wall-clock time directly — no name-to-offset table needed.
 * Converting "H:MM in this IANA zone" to a UTC instant isn't natively
 * supported by `Date`, so this uses the standard two-pass `formatToParts`
 * trick: format a first guess in the target zone, measure how far off it
 * landed, and correct. Converges in one pass for fixed-offset zones (no DST,
 * e.g. Asia/Shanghai/Asia/Singapore) and at most two for zones that do
 * observe DST.
 */
const RESET_RE = /resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/i

function partsToMap(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]))
}

function formatAsUtcMillis(instantMs: number, tz: string): number | null {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instantMs))
  } catch { return null } // unknown/invalid IANA zone name
  const map = partsToMap(parts)
  return Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second)
}

/** Finds the UTC instant T whose wall-clock time in `tz` reads (y,mo,d,h,mi). Iterates because the
 *  zone's UTC offset at T isn't known up front (DST) — converges in 1 pass for fixed-offset zones,
 *  at most 2 near a DST transition. */
function zonedWallTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number | null {
  const desiredWallAsUtc = Date.UTC(y, mo - 1, d, h, mi, 0)
  let guess = desiredWallAsUtc
  for (let i = 0; i < 2; i++) {
    const formattedAsUtc = formatAsUtcMillis(guess, tz)
    if (formattedAsUtc === null) return null
    const offset = formattedAsUtc - guess
    const nextGuess = desiredWallAsUtc - offset
    if (nextGuess === guess) break
    guess = nextGuess
  }
  return guess
}

/** Returns the UTC instant Claude's rate limit resets, or null if `text` doesn't contain a recognizable reset time. */
export function parseRateLimitResetTime(text: string, now: Date = new Date()): Date | null {
  const m = RESET_RE.exec(text)
  if (!m) return null
  let hour = parseInt(m[1], 10) % 12
  if (m[3].toLowerCase() === 'pm') hour += 12
  const minute = parseInt(m[2], 10)
  const tz = m[4].trim()

  let nowParts: Intl.DateTimeFormatPart[]
  try {
    nowParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now)
  } catch { return null } // unknown/invalid IANA zone name
  const nowMap = partsToMap(nowParts)

  const y = +nowMap.year, mo = +nowMap.month, d = +nowMap.day
  let resetMs = zonedWallTimeToUtc(y, mo, d, hour, minute, tz)
  if (resetMs === null) return null

  // "resets 9:30pm" already elapsed today in that zone → it means tomorrow.
  // `tz` already succeeded above, so this second lookup can't fail — no `?? fallback` needed.
  if (resetMs <= now.getTime()) {
    resetMs = zonedWallTimeToUtc(y, mo, d + 1, hour, minute, tz)!
  }
  return new Date(resetMs)
}
