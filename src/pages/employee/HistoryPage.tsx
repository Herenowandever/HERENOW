import { supabase, ATTENDANCE_COLS, type Attendance } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { prettyDate, timeIn, hoursBetween } from '../../lib/time'
import { friendly } from '../../lib/errors'
import { Loading, Note, Pill } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { METHOD_LABEL } from '../../supabase'

export function HistoryPage() {
  const { userId, company } = useMember()
  const tz = company.timezone
  const t = useT()
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
        <h2>{t('his.title')}</h2>
        <p className="small muted">
          {t('his.summary', { n: rows.length, hours: hours.toFixed(1), late })}
        </p>
        {rows.length === 0 ? (
          <p className="muted">{t('his.empty')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>{t('col.date')}</th><th>{t('col.in')}</th><th>{t('col.out')}</th><th className="r">{t('col.hours')}</th><th>{t('col.status')}</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const h = hoursBetween(r.clock_in_at, r.clock_out_at)
                  return (
                    <tr key={r.id}>
                      <td>{prettyDate(r.work_date)}</td>
                      <td className="num">{timeIn(tz, r.clock_in_at)} <span className="muted small">{METHOD_LABEL[r.in_method] ?? r.in_method}</span></td>
                      <td className="num">{timeIn(tz, r.clock_out_at)}</td>
                      <td className="r num">{h == null ? '—' : h.toFixed(1)}</td>
                      <td>{r.is_late ? <Pill tone="late">{t('st.late')}</Pill> : <Pill tone="ok">{t('st.onTime')}</Pill>}</td>
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
