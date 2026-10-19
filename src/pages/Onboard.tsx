import { useState, type FormEvent } from 'react'
import { supabase } from '../supabase'
import { useSession } from '../lib/session'
import { Brand } from '../components/Layout'
import { Note } from '../components/ui'
import { friendly } from '../lib/errors'
import { TIMEZONES } from '../lib/time'
import { useT, LangSwitch } from '../lib/i18n'

export function Onboard({ joinCode }: { joinCode: string }) {
  const { refresh, signOut, session } = useSession()
  const t = useT()
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
      <div className="row between"><Brand sub={session?.user.email} /><LangSwitch /></div>
      <form className="panel" onSubmit={submit}>
        <h2>{mode === 'join' ? t('ob.join') : t('ob.setup')}</h2>
        <div className="seg" role="tablist" aria-label="Get started">
          <button type="button" role="tab" aria-selected={mode === 'join'} onClick={() => setMode('join')}>{t('ob.haveCode')}</button>
          <button type="button" role="tab" aria-selected={mode === 'create'} onClick={() => setMode('create')}>{t('ob.settingUp')}</button>
        </div>
        <label className="field">
          {t('ob.name')}
          <input id="onboard-name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {mode === 'join' ? (
          <label className="field">
            {t('ob.code')}
            <input
              id="onboard-code"
              className="mono code-input"
              required
              minLength={8}
              maxLength={8}
              placeholder={t('ob.codePh')}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <span className="small muted">{t('ob.codeHint')}</span>
          </label>
        ) : (
          <>
            <label className="field">
              {t('ob.company')}
              <input id="onboard-company" required value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </label>
            <label className="field">
              {t('ob.tz')}
              <select id="onboard-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
                {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <p className="small muted">{t('ob.adminNote')}</p>
          </>
        )}
        {err && <Note tone="bad">{err}</Note>}
        <button className="btn primary big" disabled={busy}>
          {busy ? t('pleaseWait') : mode === 'join' ? t('ob.joinBtn') : t('ob.createBtn')}
        </button>
        <button type="button" className="linkish" onClick={signOut}>{t('ob.other')}</button>
      </form>
    </div>
  )
}
