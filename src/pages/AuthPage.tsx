import { useState, type FormEvent } from 'react'
import { supabase } from '../supabase'
import { Brand } from '../components/Layout'
import { Note } from '../components/ui'
import { friendly } from '../lib/errors'
import { useT, LangSwitch } from '../lib/i18n'

export function AuthPage() {
  const t = useT()
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + '/' + window.location.hash },
        })
        if (error) throw error
        if (!data.session) setMsg({ tone: 'ok', text: t('auth.confirmSent', { email }) })
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
        if (error) throw error
        setMsg({ tone: 'ok', text: t('auth.resetSent', { email }) })
      }
    } catch (err) {
      setMsg({ tone: 'bad', text: friendly(err).text })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center-page">
      <div className="row between"><Brand sub={t('auth.tagline')} /><LangSwitch /></div>
      <form className="panel" onSubmit={submit}>
        <div className="seg" role="tablist" aria-label="Account">
          <button type="button" role="tab" aria-selected={mode === 'signin'} onClick={() => setMode('signin')}>{t('auth.signIn')}</button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} onClick={() => setMode('signup')}>{t('auth.create')}</button>
        </div>
        <label className="field">
          {t('auth.email')}
          <input id="auth-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== 'reset' && (
          <label className="field">
            {t('auth.password')}
            <input
              id="auth-password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {msg && <Note tone={msg.tone}>{msg.text}</Note>}
        <button className="btn primary big" disabled={busy}>
          {busy ? t('pleaseWait') : mode === 'signin' ? t('auth.signIn') : mode === 'signup' ? t('auth.create') : t('auth.sendReset')}
        </button>
        {mode === 'signin' && (
          <button type="button" className="linkish" onClick={() => setMode('reset')}>{t('auth.forgot')}</button>
        )}
        {mode === 'reset' && (
          <button type="button" className="linkish" onClick={() => setMode('signin')}>{t('auth.back')}</button>
        )}
        {mode === 'signup' && <p className="small muted">{t('auth.afterCreate')}</p>}
      </form>
    </div>
  )
}
