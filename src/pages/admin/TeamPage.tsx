import { useState } from 'react'
import { supabase, PROFILE_COLS, type Profile, type Shift, type Role } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { friendly } from '../../lib/errors'
import { Avatar, Loading, Note, copyText } from '../../components/ui'

export function TeamPage() {
  const { company, userId, refresh } = useMember()
  const { data, loading, error, reload } = useAsync(async () => {
    const [people, shifts] = await Promise.all([
      supabase.from('profiles').select(PROFILE_COLS).order('full_name'),
      supabase.from('shifts').select('id, company_id, name, start_time, end_time, grace_minutes').order('start_time'),
    ])
    return { people: must(people) as Profile[], shifts: must(shifts) as Shift[] }
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
              <MemberRow key={p.id} p={p} shifts={data!.shifts} isMe={p.id === userId} onSaved={reload} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function MemberRow({ p, shifts, isMe, onSaved }: { p: Profile; shifts: Shift[]; isMe: boolean; onSaved: () => void }) {
  const [shift, setShift] = useState(p.shift_id ?? '')
  const [role, setRole] = useState<Role>(p.role)
  const [title, setTitle] = useState(p.job_title ?? '')
  const [active, setActive] = useState(p.active)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const dirty = shift !== (p.shift_id ?? '') || role !== p.role || title !== (p.job_title ?? '') || active !== p.active

  async function save() {
    const { error } = await supabase.rpc('update_member', {
      p_member: p.id, p_role: role, p_shift: shift || null, p_job_title: title, p_active: active,
    })
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else {
      setMsg({ tone: 'ok', text: 'Saved.' })
      onSaved()
    }
  }

  return (
    <div className={`member ${active ? '' : 'inactive'}`}>
      <div className="person">
        <Avatar name={p.full_name} />
        <div className="minw0">
          <div>{p.full_name}{isMe && <span className="muted small"> · you</span>}{!p.active && <span className="muted small"> · deactivated</span>}</div>
          <div className="meta">{p.job_title || 'No job title'}</div>
        </div>
      </div>
      <div className="member-edit">
        <label className="field">Job title<input id={`title-${p.id}`} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field">Shift
          <select id={`shift-${p.id}`} value={shift} onChange={(e) => setShift(e.target.value)}>
            <option value="">No shift</option>
            {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})</option>)}
          </select>
        </label>
        <label className="field">Role
          <select id={`role-${p.id}`} value={role} disabled={isMe} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="employee">Employee</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label className="check">
          <input id={`active-${p.id}`} type="checkbox" checked={active} disabled={isMe} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        <button className="btn primary" disabled={!dirty} onClick={save}>Save</button>
      </div>
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
    </div>
  )
}
