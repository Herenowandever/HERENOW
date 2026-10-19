import { useState } from 'react'
import { supabase } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { friendly } from '../../lib/errors'
import { timeIn, prettyDate, dateIn } from '../../lib/time'
import { Loading, Note } from '../../components/ui'

interface Entry {
  id: number
  actor: string | null
  action: string
  person: string | null
  details: Record<string, unknown>
  created_at: string
}

type Lookup = { people: Map<string, string>; shifts: Map<string, string>; offices: Map<string, string> }

const FIELD: Record<string, string> = {
  full_name: 'name', job_title: 'job title', role: 'role', shift_id: 'shift', office_id: 'site', daily_wage: 'daily wage',
  ot_hourly_rate: 'overtime rate', pay_type: 'pay type', monthly_salary: 'monthly salary', active: 'active', approved: 'approved',
  clock_in_at: 'clock-in', clock_out_at: 'clock-out', day_status: 'counts as', name: 'name', timezone: 'time zone',
  weekly_offs: 'weekly offs', paid_weekly_off: 'pay weekly off', paid_holidays: 'pay holidays', half_day_hours: 'half-day cut-off',
  ot_after_minutes: 'overtime after (min)', ot_multiplier: 'overtime rate', pay_cycle: 'pay cycle', week_starts: 'week starts',
  require_approval: 'approve new members', photo_retention_days: 'keep photos (days)', require_admin_mfa: 'require two-step login',
  join_code: 'company code', start_time: 'start', end_time: 'end', grace_minutes: 'grace (min)', lat: 'latitude', lng: 'longitude',
  radius_m: 'zone (m)', day: 'date',
}
const MONEY = new Set(['daily_wage', 'ot_hourly_rate', 'monthly_salary'])
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const GROUPS: Record<string, string> = { all: 'Everything', person: 'People', attendance: 'Attendance edits', pay: 'Advances & bonuses', settings: 'Settings' }
const groupOf = (a: string) => (a.startsWith('person.') ? 'person' : a.startsWith('attendance.') ? 'attendance' : a.startsWith('pay.') ? 'pay' : 'settings')

export function ActivityPage() {
  const { company } = useMember()
  const tz = company.timezone
  const [limit, setLimit] = useState(100)
  const [group, setGroup] = useState('all')

  const { data, loading, error } = useAsync(async () => {
    const [log, people, shifts, offices] = await Promise.all([
      supabase.from('activity_log').select('id, actor, action, person, details, created_at').order('id', { ascending: false }).limit(limit),
      supabase.from('profiles').select('id, full_name'),
      supabase.from('shifts').select('id, name'),
      supabase.from('offices').select('id, name'),
    ])
    const lk: Lookup = {
      people: new Map((must(people) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name])),
      shifts: new Map((must(shifts) as { id: string; name: string }[]).map((s) => [s.id, s.name])),
      offices: new Map((must(offices) as { id: string; name: string }[]).map((o) => [o.id, o.name])),
    }
    return { entries: must(log) as Entry[], lk }
  }, [limit])

  const entries = (data?.entries ?? []).filter((e) => group === 'all' || groupOf(e.action) === group)

  // Group by day for easier scanning.
  const byDay: [string, Entry[]][] = []
  for (const e of entries) {
    const d = dateIn(tz, new Date(e.created_at))
    const last = byDay[byDay.length - 1]
    if (last && last[0] === d) last[1].push(e)
    else byDay.push([d, [e]])
  }

  return (
    <div className="stack">
      <div className="row between">
        <h2>Activity</h2>
        <select id="act-group" className="narrow-select" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Show">
          {Object.entries(GROUPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <p className="small muted">Who changed people, wages, attendance times, advances and settings. Normal clocking in and out isn't listed here.</p>
      <section className="panel">
        {loading && !data ? <Loading /> : error ? <Note tone="bad">{friendly(error).text}</Note> : entries.length === 0 ? (
          <p className="muted">Nothing here yet.</p>
        ) : (
          <div className="activity">
            {byDay.map(([d, list]) => (
              <div key={d} className="act-day">
                <div className="label">{prettyDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
                <ul>
                  {list.map((e) => (
                    <li key={e.id}>
                      <span className="num muted act-time">{timeIn(tz, e.created_at)}</span>
                      <span className="minw0">
                        <strong>{e.actor ? data!.lk.people.get(e.actor) ?? 'Someone' : 'System'}</strong> {describe(e, data!.lk, tz)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {data && data.entries.length >= limit && (
          <div><button className="btn" onClick={() => setLimit((l) => l + 200)}>Show older</button></div>
        )}
      </section>
    </div>
  )
}

function fmt(key: string, v: unknown, lk: Lookup, tz: string): string {
  if (v === null || v === undefined || v === '') return '—'
  if (MONEY.has(key)) return '₹' + Number(v).toLocaleString('en-IN')
  if (key === 'shift_id') return lk.shifts.get(String(v)) ?? 'a removed shift'
  if (key === 'office_id') return lk.offices.get(String(v)) ?? 'a removed site'
  if (key === 'clock_in_at' || key === 'clock_out_at') return timeIn(tz, String(v))
  if (key === 'weekly_offs' && Array.isArray(v)) return v.map((d) => DAYS[Number(d)]).join(', ') || 'none'
  if (key === 'week_starts') return DAYS[Number(v)] ?? String(v)
  if (key === 'ot_multiplier') return `${Number(v)}×`
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (key === 'day') return prettyDate(String(v))
  return String(v)
}

function changes(details: Record<string, unknown>, lk: Lookup, tz: string): string {
  return Object.entries(details)
    .filter(([, v]) => Array.isArray(v) && v.length === 2)
    .map(([k, v]) => {
      const [a, b] = v as [unknown, unknown]
      return `${FIELD[k] ?? k} ${fmt(k, a, lk, tz)} → ${fmt(k, b, lk, tz)}`
    })
    .join('; ')
}

function describe(e: Entry, lk: Lookup, tz: string): string {
  const d = e.details ?? {}
  const who = (d.name as string) ?? (e.person ? lk.people.get(e.person) : undefined) ?? 'someone'
  const person = e.person ? lk.people.get(e.person) ?? (d.name as string) ?? 'someone' : who
  const [kind, verb] = [e.action.split('.')[0], e.action.split('.').slice(1).join('.')]
  switch (e.action) {
    case 'person.added': return `added ${who}${d.has_login === false ? ' (no phone)' : ''}.`
    case 'person.requested': return `asked to join as ${who}.`
    case 'person.approved': return `approved ${who}.`
    case 'person.rejected': return `turned down or withdrew the request from ${who}.`
    case 'person.deleted': return `deleted ${who}.`
    case 'person.removed': return `removed ${who} from the team.`
    case 'person.restored': return `restored ${who}.`
    case 'person.updated': return `changed ${who}: ${changes(d, lk, tz)}.`
    case 'attendance.edited': {
      const c = { ...d }
      if (Array.isArray(c.day_status)) c.day_status = (c.day_status as unknown[]).map((x) => (x == null ? 'worked out from hours' : `${x} day`))
      return `edited ${person}'s attendance on ${d.date ? prettyDate(String(d.date)) : 'a day'}: ${changes(c, lk, tz)}.`
    }
    case 'company.updated': return `changed company settings: ${changes(d, lk, tz)}${d.join_code === 'changed' ? '; made a new company code' : ''}.`
  }
  if (kind === 'pay') {
    const [type, act] = verb.split('.')
    return `${act === 'added' ? 'added' : 'deleted'} ${type === 'advance' ? 'an advance' : `a ${type}`} of ₹${Number(d.amount).toLocaleString('en-IN')} for ${person}${d.date ? ` (${prettyDate(String(d.date))})` : ''}${d.note ? ` (note: ${d.note})` : ''}.`
  }
  const thing = kind === 'shifts' ? 'shift' : kind === 'offices' ? 'site' : kind === 'holidays' ? 'holiday' : kind
  const name = (d.name as string) ?? ''
  if (verb === 'added') return `added the ${thing} ${name}.`
  if (verb === 'deleted') return `deleted the ${thing} ${name}.`
  if (verb === 'updated') return `changed the ${thing} ${name}: ${changes(d, lk, tz)}.`
  return `${e.action}.`
}
