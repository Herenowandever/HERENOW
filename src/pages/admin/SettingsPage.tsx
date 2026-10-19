import { useState, type FormEvent } from 'react'
import { supabase } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { friendly } from '../../lib/errors'
import { TIMEZONES, dateIn, prettyDate } from '../../lib/time'
import { Loading, Note } from '../../components/ui'
import { MfaSetup } from '../Security'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Holiday {
  id: string
  day: string
  name: string
}

type Msg = { tone: 'ok' | 'bad'; text: string } | null

export function SettingsPage() {
  const { company, refresh, mfa } = useMember()

  // Company details
  const [name, setName] = useState(company.name)
  const [tz, setTz] = useState(company.timezone)

  // Work week and pay rules
  const [offs, setOffs] = useState<number[]>(company.weekly_offs ?? [0])
  const [paidOff, setPaidOff] = useState(company.paid_weekly_off)
  const [paidHol, setPaidHol] = useState(company.paid_holidays)
  const [halfDay, setHalfDay] = useState(company.half_day_hours != null ? String(company.half_day_hours) : '')
  const [otAfter, setOtAfter] = useState(String(company.ot_after_minutes ?? 30))
  const [otMult, setOtMult] = useState(String(company.ot_multiplier ?? 1))
  const [cycle, setCycle] = useState(company.pay_cycle ?? 'monthly')
  const [weekStart, setWeekStart] = useState(company.week_starts ?? 1)
  const [approval, setApproval] = useState(company.require_approval ?? true)
  const [keepDays, setKeepDays] = useState(company.photo_retention_days ?? 90)
  const [requireMfa, setRequireMfa] = useState(company.require_admin_mfa ?? false)
  const [msg, setMsg] = useState<Msg>(null)
  const [saving, setSaving] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    const hd = halfDay.trim() === '' ? null : Number(halfDay)
    const oa = Number(otAfter)
    const om = Number(otMult)
    if (hd != null && (Number.isNaN(hd) || hd <= 0 || hd >= 24)) return setMsg({ tone: 'bad', text: 'Half-day cut-off must be between 0 and 24 hours, or blank.' })
    if (!Number.isInteger(oa) || oa < 0 || oa > 600) return setMsg({ tone: 'bad', text: 'Overtime minimum must be a whole number of minutes from 0 to 600.' })
    if (Number.isNaN(om) || om < 0 || om > 5) return setMsg({ tone: 'bad', text: 'Overtime rate must be between 0 and 5 times normal pay.' })
    if (offs.length >= 7) return setMsg({ tone: 'bad', text: 'Leave at least one working day in the week.' })
    if (requireMfa && !company.require_admin_mfa && !mfa.hasFactor) return setMsg({ tone: 'bad', text: 'Set up your own two-step login (at the bottom of this page) before requiring it for all admins.' })
    setSaving(true)
    const { error } = await supabase
      .from('companies')
      .update({
        name: name.trim(), timezone: tz, weekly_offs: [...offs].sort(), paid_weekly_off: paidOff, paid_holidays: paidHol,
        half_day_hours: hd, ot_after_minutes: oa, ot_multiplier: om, pay_cycle: cycle, week_starts: weekStart,
        require_approval: approval, photo_retention_days: keepDays, require_admin_mfa: requireMfa,
      })
      .eq('id', company.id)
    setSaving(false)
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else {
      setMsg({ tone: 'ok', text: 'Settings saved. Wage sheets now use these rules.' })
      await refresh()
    }
  }

  const zones = TIMEZONES.includes(company.timezone) ? TIMEZONES : [company.timezone, ...TIMEZONES]
  const toggleOff = (d: number) => setOffs((o) => (o.includes(d) ? o.filter((x) => x !== d) : [...o, d]))

  return (
    <div className="stack">
      <form className="stack" onSubmit={save}>
        <section className="panel">
          <h2>Company</h2>
          <div className="row">
            <label className="field">Company name<input id="co-name" required value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field">Time zone
              <select id="co-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
                {zones.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
          </div>
          <p className="small muted">Shift times, late marks and dates all follow this time zone.</p>
        </section>

        <section className="panel">
          <h2>Work week</h2>
          <fieldset className="day-picks">
            <legend className="small muted">Weekly off days</legend>
            {DAYS.map((d, i) => (
              <label key={d} className={`day-pick ${offs.includes(i) ? 'on' : ''}`}>
                <input type="checkbox" id={`off-${i}`} checked={offs.includes(i)} onChange={() => toggleOff(i)} />
                {d.slice(0, 3)}
              </label>
            ))}
          </fieldset>
          <p className="small muted">Off days and holidays aren't counted as absent. Monthly-salary staff are always paid for them.</p>
          <label className="check"><input type="checkbox" id="paid-off" checked={paidOff} onChange={(e) => setPaidOff(e.target.checked)} />
            Pay daily-wage workers for their weekly off</label>
          <label className="check"><input type="checkbox" id="paid-hol" checked={paidHol} onChange={(e) => setPaidHol(e.target.checked)} />
            Pay daily-wage workers for holidays</label>
        </section>

        <section className="panel">
          <h2>Half days and overtime</h2>
          <div className="row">
            <label className="field">Half day if worked less than (hours)
              <input id="half-day" inputMode="decimal" value={halfDay} placeholder="Half the shift" onChange={(e) => setHalfDay(e.target.value)} />
            </label>
            <label className="field">Count overtime only after (minutes)
              <input id="ot-after" inputMode="numeric" value={otAfter} onChange={(e) => setOtAfter(e.target.value)} />
            </label>
            <label className="field">Overtime pay rate
              <select id="ot-mult" value={otMult} onChange={(e) => setOtMult(e.target.value)}>
                {['1', '1.25', '1.5', '2'].includes(String(Number(otMult))) ? null : <option value={otMult}>{otMult}× normal</option>}
                <option value="1">1× normal hourly pay</option>
                <option value="1.25">1.25× normal</option>
                <option value="1.5">1.5× normal</option>
                <option value="2">2× normal</option>
              </select>
            </label>
          </div>
          <p className="small muted">
            Example: with a 9-hour shift and a 30-minute minimum, someone who works 9 h 20 m gets no overtime, and someone who works
            11 h gets 2 hours. Normal hourly pay is the day's pay divided by shift hours. A personal overtime rate on the Team page
            overrides this.
          </p>
        </section>

        <section className="panel">
          <h2>Pay cycle</h2>
          <div className="seg cycle-seg" role="radiogroup" aria-label="Pay cycle">
            <button type="button" role="radio" aria-checked={cycle === 'weekly'} aria-selected={cycle === 'weekly'} onClick={() => setCycle('weekly')}>Weekly</button>
            <button type="button" role="radio" aria-checked={cycle === 'monthly'} aria-selected={cycle === 'monthly'} onClick={() => setCycle('monthly')}>Monthly</button>
          </div>
          {cycle === 'weekly' && (
            <label className="field narrow">Pay week starts on
              <select id="week-start" value={weekStart} onChange={(e) => setWeekStart(Number(e.target.value))}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          )}
          <p className="small muted">The wage sheet opens on the current {cycle === 'weekly' ? 'week' : 'month'}. You can still look at any period.</p>
        </section>

        <section className="panel">
          <h2>Security and privacy</h2>
          <label className="check"><input type="checkbox" id="req-approval" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
            Approve new members before they can use Musterly</label>
          <p className="small muted">When on, people who join with your company code wait on the Team page until an admin approves them.</p>
          <label className="field narrow">Keep check-in photos for
            <select id="keep-days" value={keepDays} onChange={(e) => setKeepDays(Number(e.target.value))}>
              {[30, 60, 90, 180, 365].includes(keepDays) ? null : <option value={keepDays}>{keepDays} days</option>}
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>6 months</option>
              <option value={365}>1 year</option>
            </select>
          </label>
          <p className="small muted">Selfies and crew photos older than this are deleted automatically each night. Attendance times are kept.</p>
          <label className="check"><input type="checkbox" id="req-mfa" checked={requireMfa} onChange={(e) => setRequireMfa(e.target.checked)} />
            Require two-step login for all admins</label>
          <p className="small muted">Admins without it will be asked to set it up the next time they open Musterly. Set up your own below first.</p>
        </section>

        {msg && <Note tone={msg.tone}>{msg.text}</Note>}
        <div><button className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button></div>
      </form>

      <Holidays companyId={company.id} tz={company.timezone} />

      <section className="panel">
        <h2>Your two-step login</h2>
        <MfaSetup />
      </section>
    </div>
  )
}

function Holidays({ companyId, tz }: { companyId: string; tz: string }) {
  const year = Number(dateIn(tz).slice(0, 4))
  const { data, loading, error, reload } = useAsync(
    async () => must(await supabase.from('holidays').select('id, day, name').gte('day', `${year}-01-01`).order('day')) as Holiday[],
    [year],
  )
  const [day, setDay] = useState('')
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<Msg>(null)

  async function add(rows: { day: string; name: string }[]) {
    setMsg(null)
    const existing = new Set((data ?? []).map((h) => h.day))
    const fresh = rows.filter((r) => !existing.has(r.day))
    if (!fresh.length) return setMsg({ tone: 'bad', text: 'Those dates are already holidays.' })
    const { error } = await supabase.from('holidays').insert(fresh.map((r) => ({ ...r, company_id: companyId })))
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else {
      setDay('')
      setName('')
      reload()
    }
  }

  async function remove(id: string) {
    const { error } = await supabase.from('holidays').delete().eq('id', id)
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else reload()
  }

  const national = [
    { day: `${year}-01-26`, name: 'Republic Day' },
    { day: `${year}-08-15`, name: 'Independence Day' },
    { day: `${year}-10-02`, name: 'Gandhi Jayanti' },
  ]

  return (
    <section className="panel">
      <div className="row between">
        <h2>Holidays {year}</h2>
        <button className="btn small-btn" onClick={() => add(national)}>Add national holidays</button>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); add([{ day, name: name.trim() }]) }}>
        <label className="field">Date<input id="hol-day" type="date" required value={day} onChange={(e) => setDay(e.target.value)} /></label>
        <label className="field">Name<input id="hol-name" required value={name} placeholder="Diwali" onChange={(e) => setName(e.target.value)} /></label>
        <button className="btn primary">Add holiday</button>
      </form>
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
      {loading && !data ? <Loading /> : error ? <Note tone="bad">{friendly(error).text}</Note> : data!.length === 0 ? (
        <p className="muted small">No holidays yet. Add festivals and local holidays your sites close for.</p>
      ) : (
        <ul className="hol-list">
          {data!.map((h) => (
            <li key={h.id}>
              <span className="num">{prettyDate(h.day)}</span>
              <span className="minw0">{h.name}</span>
              <button className="btn ghost small-btn" onClick={() => remove(h.id)} aria-label={`Remove ${h.name}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">Festival dates such as Diwali, Ganesh Chaturthi and Eid change every year. Add the ones your company observes.</p>
    </section>
  )
}
