import { supabase, ATTENDANCE_COLS, type Attendance } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { prettyDate, timeIn, hoursBetween } from '../../lib/time'
import { friendly } from '../../lib/errors'
import { Loading, Note, Pill } from '../../components/ui'

export function HistoryPage() {
  const { userId, company } = useMember()
  const tz = company.timezone
  const { data, loading, error } = useAsync(
    async () =>
      must(
        await supabase.from('attendance').select(ATTENDANCE_COLS).eq('user_id', userId).order('work_date', { ascending: false }).limit(60),
      ) as Attendance[],
    [userId],
  )

  if (loading && !data) return <Loading />
  if (error) return <Note tone="bad">{friendly(error).text}</Note>
  const rows = data ?? []
  const late = rows.filter((r) => r.is_late).length
  const hours = rows.reduce((s, r) => s + (hoursBetween(r.clock_in_at, r.clock_out_at) ?? 0), 0)

  return (
    <div className="stack">
      <section className="panel">
        <h2>My attendance</h2>
        <p className="small muted">
          Last {rows.length} days on record · <span className="num">{hours.toFixed(1)}</span> hours · <span className="num">{late}</span> late
        </p>
        {rows.length === 0 ? (
          <p className="muted">No records yet. Your first clock-in will show up here.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Date</th><th>In</th><th>Out</th><th className="r">Hours</th><th>Status</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const h = hoursBetween(r.clock_in_at, r.clock_out_at)
                  return (
                    <tr key={r.id}>
                      <td>{prettyDate(r.work_date)}</td>
                      <td className="num">{timeIn(tz, r.clock_in_at)} <span className="muted small">{r.in_method.toUpperCase()}</span></td>
                      <td className="num">{timeIn(tz, r.clock_out_at)}</td>
                      <td className="r num">{h == null ? '—' : h.toFixed(1)}</td>
                      <td>{r.is_late ? <Pill tone="late">Late</Pill> : <Pill tone="ok">On time</Pill>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
