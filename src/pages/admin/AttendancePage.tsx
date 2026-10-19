import { useEffect, useMemo, useState } from 'react'
import { supabase, ATTENDANCE_COLS, PROFILE_COLS, type Attendance, type Profile, type Shift } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { dateIn, timeIn, hm, prettyDate, localToIso } from '../../lib/time'
import { friendly } from '../../lib/errors'
import { Avatar, Loading, Note, Pill } from '../../components/ui'

type Tone = 'ok' | 'late' | 'bad' | 'off'

function toMin(t: string) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

export function AttendancePage() {
  const { company } = useMember()
  const tz = company.timezone
  const today = dateIn(tz)
  const [day, setDay] = useState(today)
  const [editing, setEditing] = useState<string | null>(null)

  const { data, loading, error, reload } = useAsync(async () => {
    const [people, shifts, att] = await Promise.all([
      supabase.from('profiles').select(PROFILE_COLS).order('full_name'),
      supabase.from('shifts').select('id, company_id, name, start_time, end_time, grace_minutes'),
      supabase.from('attendance').select(ATTENDANCE_COLS).eq('work_date', day),
    ])
    const records = must(att) as Attendance[]
    const paths = records.map((r) => r.selfie_path).filter(Boolean) as string[]
    const urls: Record<string, string> = {}
    if (paths.length) {
      const { data: signed } = await supabase.storage.from('selfies').createSignedUrls(paths, 3600)
      signed?.forEach((s) => { if (s.path && s.signedUrl) urls[s.path] = s.signedUrl })
    }
    return { people: must(people) as Profile[], shifts: must(shifts) as Shift[], records, urls }
  }, [day])

  // Live updates while watching today.
  useEffect(() => {
    if (day !== today) return
    const ch = supabase
      .channel('attendance-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance', filter: `company_id=eq.${company.id}` }, () => reload())
      .subscribe()
    const t = setInterval(reload, 120000)
    return () => {
      supabase.removeChannel(ch)
      clearInterval(t)
    }
  }, [day, today, company.id, reload])

  const rows = useMemo(() => {
    if (!data) return []
    const nowParts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
    const nowMin = toMin(nowParts)
    return data.people
      .map((p) => {
        const r = data.records.find((x) => x.user_id === p.id) ?? null
        const sh = data.shifts.find((s) => s.id === p.shift_id) ?? null
        let tone: Tone
        let label: string
        if (r && r.clock_out_at) { tone = r.is_late ? 'late' : 'off'; label = r.is_late ? 'Left · was late' : 'Left' }
        else if (r) { tone = r.is_late ? 'late' : 'ok'; label = r.is_late ? 'Late' : 'On site' }
        else if (day < today || (sh && day === today && nowMin > toMin(sh.start_time) + sh.grace_minutes)) { tone = 'bad'; label = 'Not in' }
        else { tone = 'off'; label = sh ? 'Shift not started' : 'No shift' }
        return { p, r, sh, tone, label }
      })
      .filter((x) => x.p.active || x.r)
  }, [data, day, today, tz])

  const count = (t: Tone, l?: string) => rows.filter((x) => x.tone === t && (!l || x.label === l)).length
  const onSite = rows.filter((x) => x.r && !x.r.clock_out_at).length

  return (
    <div className="stack">
      <div className="row between">
        <h2>{day === today ? 'Today' : prettyDate(day, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
        <input id="att-day" type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Day" />
      </div>
      <div className="stats">
        <div className="stat"><div className="label">{day === today ? 'On site now' : 'Present'}</div><div className="n num ok-c">{day === today ? onSite : rows.filter((x) => x.r).length}</div></div>
        <div className="stat"><div className="label">Late</div><div className="n num late-c">{rows.filter((x) => x.r?.is_late).length}</div></div>
        <div className="stat"><div className="label">Not in</div><div className="n num bad-c">{count('bad')}</div></div>
        <div className="stat"><div className="label">Team</div><div className="n num">{rows.length}</div></div>
      </div>

      <section className="panel">
        {loading && !data ? <Loading /> : error ? <Note tone="bad">{friendly(error).text}</Note> : rows.length === 0 ? (
          <p className="muted">No one has joined yet. Share your company code from the Team page.</p>
        ) : (
          <div className="people">
            {rows.map(({ p, r, sh, tone, label }) => (
              <div key={p.id} className="person-wrap">
                <div className="person">
                  <Avatar name={p.full_name} src={r?.selfie_path ? data!.urls[r.selfie_path] : null} />
                  <div className="minw0">
                    <div>{p.full_name}{p.role === 'admin' && <span className="muted small"> · admin</span>}</div>
                    <div className="meta">
                      {sh ? <>{sh.name} <span className="mono">{hm(sh.start_time)}</span></> : 'No shift'}
                      {r && <> · in <span className="mono">{timeIn(tz, r.clock_in_at)}</span> {r.in_method.toUpperCase()}</>}
                      {r && r.in_distance_m != null && <> · {Math.round(r.in_distance_m)} m</>}
                      {r?.clock_out_at && <> · out <span className="mono">{timeIn(tz, r.clock_out_at)}</span></>}
                      {r?.edited_by && <> · edited</>}
                    </div>
                  </div>
                  <div className="row end">
                    <Pill tone={tone}>{label}</Pill>
                    {r && <button className="btn ghost small-btn" onClick={() => setEditing(editing === r.id ? null : r.id)}>Edit</button>}
                  </div>
                </div>
                {r && editing === r.id && (
                  <EditTimes rec={r} tz={tz} onDone={() => { setEditing(null); reload() }} />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function EditTimes({ rec, tz, onDone }: { rec: Attendance; tz: string; onDone: () => void }) {
  const [inT, setIn] = useState(timeIn(tz, rec.clock_in_at))
  const [outT, setOut] = useState(rec.clock_out_at ? timeIn(tz, rec.clock_out_at) : '')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setErr(null)
    const inIso = localToIso(tz, rec.work_date, inT)
    let outIso: string | null = null
    if (outT) {
      outIso = localToIso(tz, rec.work_date, outT)
      // A clock-out earlier than clock-in means the shift ran past midnight.
      if (outIso <= inIso) outIso = new Date(new Date(outIso).getTime() + 86400000).toISOString()
    }
    const { error } = await supabase.rpc('admin_edit_attendance', { p_id: rec.id, p_clock_in: inIso, p_clock_out: outIso })
    setBusy(false)
    if (error) setErr(friendly(error).text)
    else onDone()
  }

  return (
    <div className="edit-row">
      <label className="field">Clock in<input id={`in-${rec.id}`} type="time" value={inT} onChange={(e) => setIn(e.target.value)} /></label>
      <label className="field">Clock out<input id={`out-${rec.id}`} type="time" value={outT} onChange={(e) => setOut(e.target.value)} /></label>
      <button className="btn primary" onClick={save} disabled={busy || !inT}>Save times</button>
      {err && <Note tone="bad">{err}</Note>}
    </div>
  )
}
