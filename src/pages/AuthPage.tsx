import { useState, type FormEvent } from 'react'
import { supabase } from '../supabase'
import { Brand } from '../components/Layout'
import { Note } from '../components/ui'
import { friendly } from '../lib/errors'

export function AuthPage() {
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
        if (!data.session) setMsg({ tone: 'ok', text: `We sent a confirmation link to ${email}. Open it, then sign in here.` })
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
        if (error) throw error
        setMsg({ tone: 'ok', text: `If ${email} has an account, a password reset link is on its way.` })
      }
    } catch (err) {
      setMsg({ tone: 'bad', text: friendly(err).text })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center-page">
      <Brand sub="Attendance that knows you're here" />
      <form className="panel" onSubmit={submit}>
        <div className="seg" role="tablist" aria-label="Account">
          <button type="button" role="tab" aria-selected={mode === 'signin'} onClick={() => setMode('signin')}>Sign in</button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} onClick={() => setMode('signup')}>Create account</button>
        </div>
        <label className="field">
          Work email
          <input id="auth-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== 'reset' && (
          <label className="field">
            Password
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
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
        </button>
        {mode === 'signin' && (
          <button type="button" className="linkish" onClick={() => setMode('reset')}>Forgot your password?</button>
        )}
        {mode === 'reset' && (
          <button type="button" className="linkish" onClick={() => setMode('signin')}>Back to sign in</button>
        )}
        {mode === 'signup' && <p className="small muted">After creating your account you'll set up your company or join one with a code from your admin.</p>}
      </form>
    </div>
  )
}
