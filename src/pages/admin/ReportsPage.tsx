import { useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { dateIn, prettyDate } from '../../lib/time'
import { friendly } from '../../lib/errors'
import { Loading, Note } from '../../components/ui'

interface Row {
  user_id: string
  full_name: string
  job_title: string | null
  shift_name: string | null
  active: boolean
  days_present: number
  late_days: number
  qr_days: number
  missing_clock_outs: number
  hours_worked: number
  overtime_hours: number
}

export function ReportsPage() {
  const { company } = useMember()
  const [month, setMonth] = useState(() => dateIn(company.timezone).slice(0, 7))
  const [tab, setTab] = useState<'att' | 'wages'>('att')
  const { data, loading, error } = useAsync(
    async () => must(await supabase.rpc('monthly_report', { p_month: `${month}-01` })) as Row[],
    [month],
  )

  const rows = data ?? []
  const totals = rows.reduce(
    (t, r) => ({ days: t.days + r.days_present, late: t.late + r.late_days, hours: t.hours + Number(r.hours_worked), ot: t.ot + Number(r.overtime_hours) }),
    { days: 0, late: 0, hours: 0, ot: 0 },
  )
  const label = prettyDate(`${month}-01`, { month: 'long', year: 'numeric' })

  function exportCsv() {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const header = ['Employee', 'Job title', 'Shift', 'Days present', 'Late days', 'QR check-ins', 'Missing clock-outs', 'Hours worked', 'Overtime hours']
    const lines = [header.map(esc).join(',')].concat(
      rows.map((r) =>
        [r.full_name, r.job_title, r.shift_name, r.days_present, r.late_days, r.qr_days, r.missing_clock_outs, r.hours_worked, r.overtime_hours]
          .map(esc)
          .join(','),
      ),
    )
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `ullara-eni-${company.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${month}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const tabs = (
    <div className="seg report-tabs" role="tablist" aria-label="Report">
      <button role="tab" aria-selected={tab === 'att'} onClick={() => setTab('att')}>Attendance</button>
      <button role="tab" aria-selected={tab === 'wages'} onClick={() => setTab('wages')}>Wage sheet</button>
    </div>
  )
  if (tab === 'wages') return <WageSheet tabs={tabs} />

  return (
    <div className="stack">
      {tabs}
      <div className="row between">
        <h2>{label}</h2>
        <div className="row">
          <input id="report-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
          <button className="btn primary" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><div className="label">Days worked</div><div className="n num">{totals.days}</div></div>
        <div className="stat"><div className="label">Late arrivals</div><div className="n num late-c">{totals.late}</div></div>
        <div className="stat"><div className="label">Hours</div><div className="n num">{totals.hours.toFixed(0)}</div></div>
        <div className="stat"><div className="label">Overtime</div><div className="n num">{totals.ot.toFixed(1)}</div></div>
      </div>
      <section className="panel">
        {loading && !data ? <Loading /> : error ? <Note tone="bad">{friendly(error).text}</Note> : rows.length === 0 ? (
          <p className="muted">No attendance recorded in {label}.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th><th>Shift</th><th className="r">Days</th><th className="r">Late</th><th className="r">QR</th>
                  <th className="r">No clock-out</th><th className="r">Hours</th><th className="r">Overtime</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.user_id}>
                    <td>{r.full_name}{!r.active && <span className="muted small"> · inactive</span>}</td>
                    <td>{r.shift_name ?? '—'}</td>
                    <td className="r num">{r.days_present}</td>
                    <td className={`r num ${r.late_days ? 'late-c' : ''}`}>{r.late_days}</td>
                    <td className="r num">{r.qr_days}</td>
                    <td className={`r num ${r.missing_clock_outs ? 'bad-c' : ''}`}>{r.missing_clock_outs}</td>
                    <td className="r num">{Number(r.hours_worked).toFixed(1)}</td>
                    <td className="r num">{Number(r.overtime_hours).toFixed(1)} h</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">
          Overtime is time worked beyond each day's shift length. Days with no clock-out count zero hours; fix them on the Attendance page.
        </p>
      </section>
    </div>
  )
}

interface WageRow {
  user_id: string
  full_name: string
  job_title: string | null
  site_name: string | null
  active: boolean
  pay_type: 'daily' | 'monthly'
  daily_wage: number | null
  monthly_salary: number | null
  worked_days: number
  full_days: number
  half_days: number
  absent_days: number
  paid_off_days: number
  no_clock_out_days: number
  ot_hours: number
  base_pay: number
  ot_pay: number
  bonus: number
  advances: number
  deductions: number
  net_pay: number
}

interface Adjustment {
  id: string
  user_id: string
  day: string
  kind: 'advance' | 'deduction' | 'bonus'
  amount: number
  note: string | null
}

const inr = (n: number | string | null) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })

// Date helpers on YYYY-MM-DD strings.
const toD = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)) }
const fromD = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (s: string, n: number) => { const d = toD(s); d.setUTCDate(d.getUTCDate() + n); return fromD(d) }
function weekOf(day: string, start: number) {
  const d = toD(day)
  const back = (d.getUTCDay() - start + 7) % 7
  const from = addDays(day, -back)
  return { from, to: addDays(from, 6) }
}
function monthOf(day: string) {
  const d = toD(day)
  const from = fromD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
  const to = fromD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)))
  return { from, to }
}

function WageSheet({ tabs }: { tabs: ReactNode }) {
  const { company } = useMember()
  const today = dateIn(company.timezone)
  const [unit, setUnit] = useState<'weekly' | 'monthly'>(company.pay_cycle ?? 'monthly')
  const [anchor, setAnchor] = useState(today)
  const period = unit === 'weekly' ? weekOf(anchor, company.week_starts ?? 1) : monthOf(anchor)

  const { data, loading, error, reload } = useAsync(async () => {
    const [sheet, adj, people] = await Promise.all([
      supabase.rpc('wage_sheet_range', { p_from: period.from, p_to: period.to }),
      supabase.from('pay_adjustments').select('id, user_id, day, kind, amount, note').gte('day', period.from).lte('day', period.to).order('day'),
      supabase.from('profiles').select('id, full_name, active').eq('active', true).order('full_name'),
    ])
    return {
      rows: must(sheet) as WageRow[],
      adj: must(adj) as Adjustment[],
      people: must(people) as { id: string; full_name: string }[],
    }
  }, [period.from, period.to])

  const rows = (data?.rows ?? []).filter((r) => Number(r.worked_days) > 0 || r.daily_wage != null || r.monthly_salary != null || Number(r.net_pay) !== 0)
  const total = rows.reduce((t, r) => t + Number(r.net_pay), 0)
  const advances = rows.reduce((t, r) => t + Number(r.advances) + Number(r.deductions), 0)
  const noRate = rows.filter((r) => (r.pay_type === 'monthly' ? r.monthly_salary == null : r.daily_wage == null) && Number(r.worked_days) > 0).length
  const open = rows.reduce((t, r) => t + r.no_clock_out_days, 0)
  const label =
    unit === 'weekly'
      ? `${prettyDate(period.from, { day: 'numeric', month: 'short' })} – ${prettyDate(period.to, { day: 'numeric', month: 'short', year: 'numeric' })}`
      : prettyDate(period.from, { month: 'long', year: 'numeric' })
  const step = (dir: number) => setAnchor(unit === 'weekly' ? addDays(period.from, 7 * dir) : addDays(dir > 0 ? period.to : period.from, dir))
  const names = new Map((data?.rows ?? []).map((r) => [r.user_id, r.full_name]))

  function exportCsv() {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const header = ['Name', 'Job title', 'Site', 'Paid', 'Rate', 'Full days', 'Half days', 'Paid offs and holidays', 'Absent days',
      'Days without clock-out', 'Overtime hours', 'Basic pay', 'Overtime pay', 'Bonus', 'Advances', 'Deductions', 'Net pay']
    const lines = [header.map(esc).join(',')].concat(
      rows.map((r) =>
        [r.full_name, r.job_title, r.site_name, r.pay_type === 'monthly' ? 'Monthly' : 'Daily',
          r.pay_type === 'monthly' ? r.monthly_salary : r.daily_wage, r.full_days, r.half_days, r.paid_off_days, r.absent_days,
          r.no_clock_out_days, r.ot_hours, r.base_pay, r.ot_pay, r.bonus, r.advances, r.deductions, r.net_pay].map(esc).join(','),
      ),
    )
    lines.push(['Total', ...Array(15).fill(''), total.toFixed(2)].map(esc).join(','))
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `ullara-eni-wages-${company.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${period.from}-to-${period.to}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return (
    <div className="stack">
      {tabs}
      <div className="row between">
        <div className="row period">
          <button className="btn small-btn" onClick={() => step(-1)} aria-label="Previous period">‹</button>
          <h2>{label}</h2>
          <button className="btn small-btn" onClick={() => step(1)} disabled={period.to >= today} aria-label="Next period">›</button>
        </div>
        <div className="row">
          <div className="seg" role="tablist" aria-label="Period">
            <button role="tab" aria-selected={unit === 'weekly'} onClick={() => setUnit('weekly')}>Week</button>
            <button role="tab" aria-selected={unit === 'monthly'} onClick={() => setUnit('monthly')}>Month</button>
          </div>
          <button className="btn primary" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><div className="label">Net to pay</div><div className="n num stat-money">₹{Math.round(total).toLocaleString('en-IN')}</div></div>
        <div className="stat"><div className="label">Advances & deductions</div><div className="n num stat-money">₹{Math.round(advances).toLocaleString('en-IN')}</div></div>
        <div className="stat"><div className="label">No pay rate set</div><div className={`n num ${noRate ? 'late-c' : ''}`}>{noRate}</div></div>
        <div className="stat"><div className="label">No clock-out</div><div className={`n num ${open ? 'bad-c' : ''}`}>{open}</div></div>
      </div>
      <section className="panel">
        {loading && !data ? <Loading /> : error ? <Note tone="bad">{friendly(error).text}</Note> : rows.length === 0 ? (
          <p className="muted">Nothing to pay for {label}. Set daily wages or salaries on the Team page.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th className="r">Rate</th><th className="r">Days</th><th className="r">Off paid</th><th className="r">Absent</th>
                  <th className="r">OT hrs</th><th className="r">Basic</th><th className="r">OT pay</th><th className="r">+ / −</th><th className="r">Net</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const adj = Number(r.bonus) - Number(r.advances) - Number(r.deductions)
                  const rate = r.pay_type === 'monthly' ? r.monthly_salary : r.daily_wage
                  return (
                    <tr key={r.user_id}>
                      <td>
                        {r.full_name}
                        {r.no_clock_out_days > 0 && <span className="bad-c small"> · {r.no_clock_out_days} no clock-out</span>}
                        <div className="small muted">{r.site_name ?? 'No site'}</div>
                      </td>
                      <td className={`r num ${rate == null ? 'late-c' : ''}`}>{rate == null ? 'not set' : `${inr(rate)}/${r.pay_type === 'monthly' ? 'mo' : 'day'}`}</td>
                      <td className="r num">{r.full_days}{r.half_days ? ` + ${r.half_days}½` : ''}</td>
                      <td className="r num">{r.paid_off_days}</td>
                      <td className={`r num ${r.absent_days ? 'bad-c' : ''}`}>{r.absent_days}</td>
                      <td className="r num">{Number(r.ot_hours).toFixed(1)}</td>
                      <td className="r num">{inr(r.base_pay)}</td>
                      <td className="r num">{inr(r.ot_pay)}</td>
                      <td className={`r num ${adj < 0 ? 'bad-c' : ''}`}>{adj === 0 ? '—' : (adj > 0 ? '+' : '−') + inr(Math.abs(adj))}</td>
                      <td className="r num"><strong>{inr(r.net_pay)}</strong></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">
          Pay follows the rules in Company settings. Days without a clock-out count as full days; change any day on the Attendance
          page. Absent means a working day with no attendance, from the day the person was added.
        </p>
      </section>

      {data && <Adjustments people={data.people} items={data.adj} names={names} period={period} onChange={reload} />}
    </div>
  )
}

const KIND_LABEL = { advance: 'Advance', deduction: 'Deduction', bonus: 'Bonus' } as const

function Adjustments({ people, items, names, period, onChange }: {
  people: { id: string; full_name: string }[]
  items: Adjustment[]
  names: Map<string, string>
  period: { from: string; to: string }
  onChange: () => void
}) {
  const { company } = useMember()
  const today = dateIn(company.timezone)
  const [person, setPerson] = useState(people[0]?.id ?? '')
  const [kind, setKind] = useState<Adjustment['kind']>('advance')
  const [amount, setAmount] = useState('')
  const [day, setDay] = useState(today >= period.from && today <= period.to ? today : period.to)
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  async function add(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    const amt = Number(amount)
    if (!person) return setMsg({ tone: 'bad', text: 'Choose a person.' })
    if (!(amt > 0)) return setMsg({ tone: 'bad', text: 'Enter an amount greater than 0.' })
    const { error } = await supabase.from('pay_adjustments').insert({
      company_id: company.id, user_id: person, kind, amount: amt, day, note: note.trim() || null,
    })
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else {
      const who = people.find((p) => p.id === person)?.full_name ?? ''
      setMsg({ tone: 'ok', text: `${KIND_LABEL[kind]} of ${inr(amt)} added for ${who}.${day < period.from || day > period.to ? ' It falls outside this period.' : ''}` })
      setAmount('')
      setNote('')
      onChange()
    }
  }

  async function remove(id: string) {
    const { error } = await supabase.from('pay_adjustments').delete().eq('id', id)
    setConfirmDel(null)
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else onChange()
  }

  return (
    <section className="panel">
      <h2>Advances, deductions and bonuses</h2>
      <p className="small muted">Advances and deductions are subtracted from net pay in the period of their date; bonuses are added.</p>
      <form className="row" onSubmit={add}>
        <label className="field">Person
          <select id="adj-person" value={person} onChange={(e) => setPerson(e.target.value)}>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </label>
        <label className="field">Type
          <select id="adj-kind" value={kind} onChange={(e) => setKind(e.target.value as Adjustment['kind'])}>
            <option value="advance">Advance (cash given)</option>
            <option value="deduction">Deduction</option>
            <option value="bonus">Bonus</option>
          </select>
        </label>
        <label className="field">Amount (₹)<input id="adj-amount" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field">Date<input id="adj-day" type="date" required value={day} onChange={(e) => setDay(e.target.value)} /></label>
        <label className="field">Note<input id="adj-note" value={note} maxLength={200} placeholder="Optional" onChange={(e) => setNote(e.target.value)} /></label>
        <button className="btn primary">Add</button>
      </form>
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
      {items.length === 0 ? (
        <p className="muted small">None in this period.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Date</th><th>Name</th><th>Type</th><th className="r">Amount</th><th>Note</th><th /></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="num">{prettyDate(a.day)}</td>
                  <td>{names.get(a.user_id) ?? people.find((p) => p.id === a.user_id)?.full_name ?? '—'}</td>
                  <td>{KIND_LABEL[a.kind]}</td>
                  <td className={`r num ${a.kind === 'bonus' ? 'ok-c' : 'bad-c'}`}>{a.kind === 'bonus' ? '+' : '−'}{inr(a.amount)}</td>
                  <td className="muted">{a.note ?? ''}</td>
                  <td className="r">
                    {confirmDel === a.id ? (
                      <span className="row end">
                        <button className="btn small-btn" onClick={() => remove(a.id)}>Delete</button>
                        <button className="btn ghost small-btn" onClick={() => setConfirmDel(null)}>Keep</button>
                      </span>
                    ) : (
                      <button className="btn ghost small-btn" onClick={() => setConfirmDel(a.id)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
