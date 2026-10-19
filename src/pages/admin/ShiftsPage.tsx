import { useState, type FormEvent } from 'react'
import { supabase, type Shift } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { friendly } from '../../lib/errors'
import { Loading, Note } from '../../components/ui'

const COLS = 'id, company_id, name, start_time, end_time, grace_minutes'

export function ShiftsPage() {
  const { company } = useMember()
  const { data, loading, error, reload } = useAsync(
    async () => must(await supabase.from('shifts').select(COLS).order('start_time')) as Shift[],
    [],
  )
  const [editing, setEditing] = useState<Shift | null>(null)

  return (
    <div className="stack">
      <section className="panel">
        <h2>Shifts</h2>
        <p className="small muted">People who clock in after a shift's start time plus its grace period are marked late. Shifts can run past midnight.</p>
        {loading && !data ? <Loading /> : error ? <Note tone="bad">{friendly(error).text}</Note> : (
          <div className="tablewrap">
            <table>
              <thead><tr><th>Shift</th><th>Start</th><th>End</th><th className="r">Grace</th><th /></tr></thead>
              <tbody>
                {data!.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="num">{s.start_time.slice(0, 5)}</td>
                    <td className="num">{s.end_time.slice(0, 5)}</td>
                    <td className="r num">{s.grace_minutes} min</td>
                    <td className="r"><button className="btn ghost small-btn" onClick={() => setEditing(s)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ShiftForm key={editing?.id ?? 'new'} companyId={company.id} shift={editing} onDone={() => { setEditing(null); reload() }} />
    </div>
  )
}

function ShiftForm({ companyId, shift, onDone }: { companyId: string; shift: Shift | null; onDone: () => void }) {
  const [name, setName] = useState(shift?.name ?? '')
  const [start, setStart] = useState(shift?.start_time.slice(0, 5) ?? '09:30')
  const [end, setEnd] = useState(shift?.end_time.slice(0, 5) ?? '18:30')
  const [grace, setGrace] = useState(shift?.grace_minutes ?? 10)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    const row = { name: name.trim(), start_time: start, end_time: end, grace_minutes: grace }
    const res = shift
      ? await supabase.from('shifts').update(row).eq('id', shift.id)
      : await supabase.from('shifts').insert({ ...row, company_id: companyId })
    if (res.error) setErr(friendly(res.error).text)
    else onDone()
  }

  async function remove() {
    if (!shift) return
    const { error } = await supabase.from('shifts').delete().eq('id', shift.id)
    if (error) setErr(friendly(error).text)
    else onDone()
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>{shift ? `Edit ${shift.name}` : 'Add a shift'}</h2>
      <div className="row">
        <label className="field">Name<input id="shift-name" required value={name} placeholder="Night" onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Start<input id="shift-start" type="time" required value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="field">End<input id="shift-end" type="time" required value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <label className="field">Grace (minutes)<input id="shift-grace" type="number" min={0} max={180} value={grace} onChange={(e) => setGrace(Number(e.target.value))} /></label>
      </div>
      {err && <Note tone="bad">{err}</Note>}
      <div className="row">
        <button className="btn primary">{shift ? 'Save shift' : 'Add shift'}</button>
        {shift && <button type="button" className="btn" onClick={onDone}>Cancel</button>}
        {shift && !confirmDel && <button type="button" className="btn ghost" onClick={() => setConfirmDel(true)}>Delete</button>}
      </div>
      {shift && confirmDel && (
        <Note tone="bad">
          People on this shift will have no shift until you assign another. Past records keep their times.{' '}
          <button type="button" className="btn" onClick={remove}>Delete shift</button>{' '}
          <button type="button" className="btn" onClick={() => setConfirmDel(false)}>Keep it</button>
        </Note>
      )}
    </form>
  )
}
