import { useState, type FormEvent } from 'react'
import { supabase } from '../supabase'
import { useSession } from '../lib/session'
import { Brand } from '../components/Layout'
import { Note } from '../components/ui'
import { friendly } from '../lib/errors'
import { TIMEZONES } from '../lib/time'

export function Onboard({ joinCode }: { joinCode: string }) {
  const { refresh, signOut, session } = useSession()
  const [mode, setMode] = useState<'join' | 'create'>('join')
  const [name, setName] = useState('')
  const [code, setCode] = useState(joinCode.toUpperCase())
  const [companyName, setCompanyName] = useState('')
  const [tz, setTz] = useState(() => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone
    return TIMEZONES.includes(local) ? local : 'Asia/Kolkata'
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    const res =
      mode === 'join'
        ? await supabase.rpc('join_company', { p_join_code: code, p_full_name: name })
        : await supabase.rpc('create_company', { p_company_name: companyName, p_full_name: name, p_timezone: tz })
    if (res.error) {
      setErr(friendly(res.error).text)
      setBusy(false)
      return
    }
    window.location.hash = mode === 'create' ? '/admin/offices' : '/'
    await refresh()
  }

  return (
    <div className="center-page">
      <Brand sub={session?.user.email} />
      <form className="panel" onSubmit={submit}>
        <h2>{mode === 'join' ? 'Join your company' : 'Set up your company'}</h2>
        <div className="seg" role="tablist" aria-label="Get started">
          <button type="button" role="tab" aria-selected={mode === 'join'} onClick={() => setMode('join')}>I have a company code</button>
          <button type="button" role="tab" aria-selected={mode === 'create'} onClick={() => setMode('create')}>I'm setting up my company</button>
        </div>
        <label className="field">
          Your full name
          <input id="onboard-name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {mode === 'join' ? (
          <label className="field">
            Company code
            <input
              id="onboard-code"
              className="mono code-input"
              required
              minLength={8}
              maxLength={8}
              placeholder="8 letters and numbers"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <span className="small muted">Your admin can find this under Team.</span>
          </label>
        ) : (
          <>
            <label className="field">
              Company name
              <input id="onboard-company" required value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </label>
            <label className="field">
              Time zone
              <select id="onboard-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
                {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <p className="small muted">You'll be the admin. Next you'll add your office location so people can clock in.</p>
          </>
        )}
        {err && <Note tone="bad">{err}</Note>}
        <button className="btn primary big" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'join' ? 'Join company' : 'Create company'}
        </button>
        <button type="button" className="linkish" onClick={signOut}>Use a different account</button>
      </form>
    </div>
  )
}
