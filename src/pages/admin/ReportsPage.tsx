import { useState, type ReactNode } from 'react'
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
    a.download = `herenow-${company.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${month}.csv`
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
  if (tab === 'wages') return <WageSheet month={month} setMonth={setMonth} tabs={tabs} companyName={company.name} />

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
  daily_wage: number | null
  ot_hourly_rate: number | null
  full_days: number
  half_days: number
  no_clock_out_days: number
  ot_hours: number
  base_pay: number
  ot_pay: number
  total_pay: number
}

const inr = (n: number) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 })

function WageSheet({ month, setMonth, tabs, companyName }: { month: string; setMonth: (m: string) => void; tabs: ReactNode; companyName: string }) {
  const { data, loading, error } = useAsync(
    async () => must(await supabase.rpc('wage_sheet', { p_month: `${month}-01` })) as WageRow[],
    [month],
  )
  const rows = (data ?? []).filter((r) => r.full_days + r.half_days > 0 || r.daily_wage != null)
  const total = rows.reduce((t, r) => t + Number(r.total_pay), 0)
  const missingWage = rows.filter((r) => r.daily_wage == null && r.full_days + r.half_days > 0).length
  const open = rows.reduce((t, r) => t + r.no_clock_out_days, 0)
  const label = prettyDate(`${month}-01`, { month: 'long', year: 'numeric' })

  function exportCsv() {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const header = ['Name', 'Job title', 'Site', 'Daily wage', 'Full days', 'Half days', 'Days without clock-out', 'Overtime hours', 'Overtime rate per hour', 'Basic pay', 'Overtime pay', 'Total pay']
    const lines = [header.map(esc).join(',')].concat(
      rows.map((r) =>
        [r.full_name, r.job_title, r.site_name, r.daily_wage, r.full_days, r.half_days, r.no_clock_out_days, r.ot_hours,
          r.ot_hourly_rate ?? 'auto', r.base_pay, r.ot_pay, r.total_pay].map(esc).join(','),
      ),
    )
    lines.push(['Total', '', '', '', '', '', '', '', '', '', '', total.toFixed(2)].map(esc).join(','))
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `herenow-wages-${companyName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${month}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return (
    <div className="stack">
      {tabs}
      <div className="row between">
        <h2>Wages · {label}</h2>
        <div className="row">
          <input id="wage-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
          <button className="btn primary" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><div className="label">Total to pay</div><div className="n num stat-money">₹{Math.round(total).toLocaleString('en-IN')}</div></div>
        <div className="stat"><div className="label">People</div><div className="n num">{rows.length}</div></div>
        <div className="stat"><div className="label">No wage set</div><div className={`n num ${missingWage ? 'late-c' : ''}`}>{missingWage}</div></div>
        <div className="stat"><div className="label">No clock-out</div><div className={`n num ${open ? 'bad-c' : ''}`}>{open}</div></div>
      </div>
      <section className="panel">
        {loading && !data ? <Loading /> : error ? <Note tone="bad">{friendly(error).text}</Note> : rows.length === 0 ? (
          <p className="muted">No wages for {label} yet. Set daily wages on the Team page.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Site</th><th className="r">Wage/day</th><th className="r">Full</th><th className="r">Half</th>
                  <th className="r">OT hrs</th><th className="r">Basic</th><th className="r">OT pay</th><th className="r">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.user_id}>
                    <td>{r.full_name}{r.no_clock_out_days > 0 && <span className="bad-c small"> · {r.no_clock_out_days} no clock-out</span>}</td>
                    <td>{r.site_name ?? '—'}</td>
                    <td className={`r num ${r.daily_wage == null ? 'late-c' : ''}`}>{r.daily_wage == null ? 'not set' : inr(r.daily_wage)}</td>
                    <td className="r num">{r.full_days}</td>
                    <td className="r num">{r.half_days}</td>
                    <td className="r num">{Number(r.ot_hours).toFixed(1)}</td>
                    <td className="r num">{inr(r.base_pay)}</td>
                    <td className="r num">{inr(r.ot_pay)}</td>
                    <td className="r num"><strong>{inr(r.total_pay)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">
          A day counts as a half day when someone works less than half their shift. Days without a clock-out count as full days;
          change any day on the Attendance page. Overtime is time beyond the shift, paid at the person's overtime rate, or their
          daily wage divided by shift hours when no rate is set.
        </p>
      </section>
    </div>
  )
}
