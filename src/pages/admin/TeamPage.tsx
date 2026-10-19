import { useState, type FormEvent } from 'react'
import { supabase, PROFILE_COLS, type Profile, type Shift, type Role, type Office } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { friendly } from '../../lib/errors'
import { Avatar, Loading, Note, copyText } from '../../components/ui'

export function TeamPage() {
  const { company, userId, refresh } = useMember()
  const { data, loading, error, reload } = useAsync(async () => {
    const [people, shifts, offices] = await Promise.all([
      supabase.from('profiles').select(PROFILE_COLS).order('full_name'),
      supabase.from('shifts').select('id, company_id, name, start_time, end_time, grace_minutes').order('start_time'),
      supabase.from('offices').select('id, company_id, name, lat, lng, radius_m').order('name'),
    ])
    return { people: must(people) as Profile[], shifts: must(shifts) as Shift[], offices: must(offices) as Office[] }
  }, [])
  const [copied, setCopied] = useState<string | null>(null)
  const [codeMsg, setCodeMsg] = useState<string | null>(null)
  const [confirmNew, setConfirmNew] = useState(false)

  const link = `${window.location.origin}/#/join?code=${company.join_code}`

  async function copy(what: string, text: string) {
    setCopied((await copyText(text)) ? what : null)
    setTimeout(() => setCopied(null), 2000)
  }

  async function newCode() {
    const { error } = await supabase.rpc('regenerate_join_code')
    setConfirmNew(false)
    if (error) setCodeMsg(friendly(error).text)
    else {
      setCodeMsg('New code created. The old code no longer works.')
      await refresh()
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <h2>Invite your team</h2>
        <p className="small muted">New employees create an account and enter this code. Share the link and the code fills in by itself.</p>
        <div className="invite">
          <div className="code num">{company.join_code}</div>
          <div className="row">
            <button className="btn" onClick={() => copy('code', company.join_code)}>{copied === 'code' ? 'Copied' : 'Copy code'}</button>
            <button className="btn" onClick={() => copy('link', link)}>{copied === 'link' ? 'Copied' : 'Copy invite link'}</button>
          </div>
        </div>
        <div className="small muted break">{link}</div>
        {!confirmNew ? (
          <button className="linkish" onClick={() => setConfirmNew(true)}>Create a new code</button>
        ) : (
          <Note tone="bad">
            Anyone with the old code won't be able to join. <button className="btn" onClick={newCode}>Create new code</button>{' '}
            <button className="btn" onClick={() => setConfirmNew(false)}>Cancel</button>
          </Note>
        )}
        {codeMsg && <Note tone="ok">{codeMsg}</Note>}
      </section>

      <section className="panel">
        <h2>People</h2>
        {loading && !data ? <Loading /> : error ? <Note tone="bad">{friendly(error).text}</Note> : (
          <div className="people">
            {data!.people.map((p) => (
              <MemberRow key={p.id} p={p} shifts={data!.shifts} offices={data!.offices} isMe={p.id === userId} onSaved={reload} />
            ))}
          </div>
        )}
      </section>

      {data && <AddWorker shifts={data.shifts} offices={data.offices} onAdded={reload} />}
    </div>
  )
}

function MemberRow({ p, shifts, offices, isMe, onSaved }: { p: Profile; shifts: Shift[]; offices: Office[]; isMe: boolean; onSaved: () => void }) {
  const [name, setName] = useState(p.full_name)
  const [shift, setShift] = useState(p.shift_id ?? '')
  const [site, setSite] = useState(p.office_id ?? '')
  const [role, setRole] = useState<Role>(p.role)
  const [title, setTitle] = useState(p.job_title ?? '')
  const [wage, setWage] = useState(p.daily_wage != null ? String(p.daily_wage) : '')
  const [ot, setOt] = useState(p.ot_hourly_rate != null ? String(p.ot_hourly_rate) : '')
  const [active, setActive] = useState(p.active)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const num = (v: string) => (v.trim() === '' ? null : Number(v))
  const dirty =
    name !== p.full_name || shift !== (p.shift_id ?? '') || site !== (p.office_id ?? '') || role !== p.role ||
    title !== (p.job_title ?? '') || num(wage) !== p.daily_wage || num(ot) !== p.ot_hourly_rate || active !== p.active

  async function save() {
    setMsg(null)
    if ((num(wage) ?? 0) < 0 || Number.isNaN(num(wage)) || (num(ot) ?? 0) < 0 || Number.isNaN(num(ot))) {
      setMsg({ tone: 'bad', text: 'Wages must be numbers of 0 or more.' })
      return
    }
    const { error } = await supabase.rpc('update_member', {
      p_member: p.id, p_role: role, p_shift: shift || null, p_job_title: title, p_active: active,
      p_office: site || null, p_daily_wage: num(wage), p_ot_rate: num(ot), p_full_name: name,
    })
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else {
      setMsg({ tone: 'ok', text: 'Saved.' })
      onSaved()
    }
  }

  const siteName = offices.find((o) => o.id === p.office_id)?.name
  return (
    <div className={`member ${active ? '' : 'inactive'}`}>
      <div className="person">
        <Avatar name={p.full_name} />
        <div className="minw0">
          <div>
            {p.full_name}
            {isMe && <span className="muted small"> · you</span>}
            {!p.has_login && <span className="muted small"> · no phone</span>}
            {p.role !== 'employee' && <span className="muted small"> · {p.role}</span>}
            {!p.active && <span className="muted small"> · deactivated</span>}
          </div>
          <div className="meta">
            {[p.job_title, siteName, p.daily_wage != null ? `₹${p.daily_wage}/day` : null].filter(Boolean).join(' · ') || 'No details yet'}
          </div>
        </div>
      </div>
      <details className="member-details">
        <summary>Edit</summary>
        <div className="member-edit">
          {!p.has_login && <label className="field">Name<input id={`name-${p.id}`} value={name} onChange={(e) => setName(e.target.value)} /></label>}
          <label className="field">Job title<input id={`title-${p.id}`} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field">Site
            <select id={`site-${p.id}`} value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">No site</option>
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="field">Shift
            <select id={`shift-${p.id}`} value={shift} onChange={(e) => setShift(e.target.value)}>
              <option value="">No shift</option>
              {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})</option>)}
            </select>
          </label>
          <label className="field">Role
            <select id={`role-${p.id}`} value={role} disabled={isMe || !p.has_login} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="employee">Employee</option>
              <option value="supervisor">Supervisor</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label className="field">Daily wage (₹)<input id={`wage-${p.id}`} inputMode="decimal" value={wage} placeholder="e.g. 800" onChange={(e) => setWage(e.target.value)} /></label>
          <label className="field">Overtime ₹/hour<input id={`ot-${p.id}`} inputMode="decimal" value={ot} placeholder="Auto" onChange={(e) => setOt(e.target.value)} /></label>
          <label className="check">
            <input id={`active-${p.id}`} type="checkbox" checked={active} disabled={isMe} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
          <button className="btn primary" disabled={!dirty} onClick={save}>Save</button>
        </div>
        {role === 'supervisor' && <p className="small muted">Supervisors mark attendance for everyone at their site. Pick a site above.</p>}
        <p className="small muted">Overtime left blank is paid at the daily wage divided by shift hours.</p>
      </details>
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
    </div>
  )
}

function AddWorker({ shifts, offices, onAdded }: { shifts: Shift[]; offices: Office[]; onAdded: () => void }) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [site, setSite] = useState(offices[0]?.id ?? '')
  const [shift, setShift] = useState(shifts[0]?.id ?? '')
  const [wage, setWage] = useState('')
  const [ot, setOt] = useState('')
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const w = wage.trim() ? Number(wage) : null
    const o = ot.trim() ? Number(ot) : null
    if ((w != null && (Number.isNaN(w) || w < 0)) || (o != null && (Number.isNaN(o) || o < 0))) {
      setMsg({ tone: 'bad', text: 'Wages must be numbers of 0 or more.' })
      return
    }
    const { error } = await supabase.rpc('add_worker', {
      p_full_name: name, p_job_title: title, p_shift: shift || null, p_office: site || null, p_daily_wage: w, p_ot_rate: o,
    })
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else {
      setMsg({ tone: 'ok', text: `${name} added. A supervisor or admin marks their attendance from the Crew page.` })
      setName('')
      setTitle('')
      onAdded()
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Add a worker without a phone</h2>
      <p className="small muted">For labourers and staff who won't use the app themselves. Their site supervisor marks them in and out with a group photo.</p>
      <div className="row">
        <label className="field">Full name<input id="aw-name" required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Job title<input id="aw-title" value={title} placeholder="Mason, helper…" onChange={(e) => setTitle(e.target.value)} /></label>
      </div>
      <div className="row">
        <label className="field">Site
          <select id="aw-site" value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">No site</option>
            {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label className="field">Shift
          <select id="aw-shift" value={shift} onChange={(e) => setShift(e.target.value)}>
            <option value="">No shift</option>
            {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field">Daily wage (₹)<input id="aw-wage" inputMode="decimal" value={wage} placeholder="e.g. 800" onChange={(e) => setWage(e.target.value)} /></label>
        <label className="field">Overtime ₹/hour<input id="aw-ot" inputMode="decimal" value={ot} placeholder="Auto" onChange={(e) => setOt(e.target.value)} /></label>
      </div>
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
      <div><button className="btn primary">Add worker</button></div>
    </form>
  )
}
