// All dates are shown in the company's timezone, not the phone's.

export function dateIn(tz: string, d: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export function timeIn(tz: string, iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  )
}

export function prettyDate(ymd: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' })
}

export function hm(t: string | null | undefined): string {
  return t ? t.slice(0, 5) : '—'
}

export function hoursBetween(a: string, b: string | null): number | null {
  if (!b) return null
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000
}

// Converts a local wall-clock time in `tz` on `ymd` to an ISO instant.
export function localToIso(tz: string, ymd: string, hhmm: string): string {
  const [y, mo, d] = ymd.split('-').map(Number)
  const [h, mi] = hhmm.split(':').map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const offset = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(t))
    const g = (k: string) => Number(parts.find((p) => p.type === k)?.value)
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - t
  }
  let t = guess - offset(guess)
  t = guess - offset(t)
  return new Date(t).toISOString()
}

export const TIMEZONES = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Colombo',
  'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'UTC',
]
