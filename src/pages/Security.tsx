import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../supabase'
import { useSession } from '../lib/session'
import { useT, LangSwitch } from '../lib/i18n'
import { friendly } from '../lib/errors'
import { Brand } from '../components/Layout'
import { Note } from '../components/ui'

/** Shown to someone who joined with a code and is waiting for an admin to approve them. */
export function PendingScreen() {
  const t = useT()
  const { refresh, signOut } = useSession()
  const [company, setCompany] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.rpc('my_pending_company').then(({ data }) => setCompany((data as string | null) ?? null))
  }, [])

  async function cancel() {
    setBusy(true)
    await supabase.rpc('cancel_join_request')
    await refresh()
    setBusy(false)
  }

  return (
    <div className="center-page">
      <div className="row between"><Brand /><LangSwitch /></div>
      <div className="panel">
        <h2>{t('pend.title')}</h2>
        <p>{t('pend.body', { company: company ?? t('pend.unknown') })}</p>
        <div className="row">
          <button className="btn primary" onClick={() => refresh()} disabled={busy}>{t('pend.check')}</button>
          <button className="btn" onClick={cancel} disabled={busy}>{t('pend.cancel')}</button>
          <button className="btn ghost" onClick={signOut}>{t('signOut')}</button>
        </div>
      </div>
    </div>
  )
}

function CodeInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  return (
    <input
      id={id}
      className="mono code-input otp"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      placeholder="123456"
      aria-label="6-digit code"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  )
}

/** Asks for the authenticator code after signing in with a password. */
export function MfaChallenge() {
  const { mfa, refresh, signOut } = useSession()
  const [code, setCode] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!mfa.factorId) return
    setBusy(true)
    setErr(null)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: mfa.factorId, code })
    setBusy(false)
    if (error) {
      setErr("That code didn't work. Codes change every 30 seconds; enter the one showing now.")
      setCode('')
    } else await refresh()
  }

  return (
    <div className="center-page">
      <Brand />
      <form className="panel" onSubmit={submit}>
        <h2>Enter your sign-in code</h2>
        <p>Open your authenticator app (for example Google Authenticator) and enter the 6-digit code for HereNow.</p>
        <CodeInput id="mfa-code" value={code} onChange={setCode} />
        {err && <Note tone="bad">{err}</Note>}
        <button className="btn primary big" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Continue'}</button>
        <button type="button" className="linkish" onClick={signOut}>Sign out</button>
        <p className="small muted">Lost your phone? Contact HereNow to reset your two-step login.</p>
      </form>
    </div>
  )
}

/** Sets up an authenticator app. Used on the Company page, and as a full screen when the company requires it. */
export function MfaSetup({ forced = false }: { forced?: boolean }) {
  const { mfa, refresh, signOut } = useSession()
  const [step, setStep] = useState<'idle' | 'scan'>('idle')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)

  async function start() {
    setBusy(true)
    setMsg(null)
    try {
      // Clear any half-finished setup first.
      const { data: list } = await supabase.auth.mfa.listFactors()
      for (const f of list?.all ?? []) {
        if (f.factor_type === 'totp' && f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id })
      }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `HereNow ${new Date().toISOString().slice(0, 10)}` })
      if (error) throw error
      setFactorId(data.id)
      setQr(data.totp.qr_code)
      setSecret(data.totp.secret)
      setStep('scan')
    } catch (e) {
      setMsg({ tone: 'bad', text: friendly(e).text })
    } finally {
      setBusy(false)
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setBusy(true)
    setMsg(null)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
    setBusy(false)
    if (error) {
      setMsg({ tone: 'bad', text: "That code didn't work. Enter the code showing in the app right now." })
      setCode('')
    } else {
      setStep('idle')
      setMsg({ tone: 'ok', text: 'Two-step login is on. You will be asked for a code each time you sign in.' })
      await refresh()
    }
  }

  async function turnOff() {
    if (!mfa.factorId) return
    setBusy(true)
    const { error } = await supabase.auth.mfa.unenroll({ factorId: mfa.factorId })
    setBusy(false)
    setConfirmOff(false)
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else {
      setMsg({ tone: 'ok', text: 'Two-step login is off for your account.' })
      await refresh()
    }
  }

  const body = (
    <>
      {step === 'idle' && !mfa.hasFactor && (
        <>
          <p className={forced ? '' : 'small muted'}>
            {forced
              ? 'Your company requires admins to use two-step login. Set it up to continue. You need an authenticator app such as Google Authenticator or Microsoft Authenticator on your phone.'
              : 'Protect your admin account with a 6-digit code from an authenticator app, such as Google Authenticator, each time you sign in.'}
          </p>
          <div><button type="button" className="btn primary" onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Set up two-step login'}</button></div>
        </>
      )}
      {step === 'scan' && (
        <form className="stack" onSubmit={verify}>
          <ol className="small steps-list">
            <li>Open your authenticator app and add a new account.</li>
            <li>Scan this QR code, or type the key below.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          {qr && <img className="mfa-qr" src={qr} alt="QR code for your authenticator app" />}
          {secret && <div className="small">Key: <span className="mono break">{secret}</span></div>}
          <div className="row">
            <CodeInput id="mfa-setup-code" value={code} onChange={setCode} />
            <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Turn on'}</button>
            <button type="button" className="btn" onClick={() => setStep('idle')}>Cancel</button>
          </div>
        </form>
      )}
      {step === 'idle' && mfa.hasFactor && (
        <>
          <p className="small">Two-step login is <strong>on</strong> for your account.</p>
          {!confirmOff ? (
            <div><button type="button" className="btn ghost small-btn" onClick={() => setConfirmOff(true)}>Turn off</button></div>
          ) : (
            <Note tone="bad">
              Turning this off makes your admin account easier to break into.
              <div className="row">
                <button type="button" className="btn" onClick={turnOff} disabled={busy}>Turn off</button>
                <button type="button" className="btn" onClick={() => setConfirmOff(false)}>Keep it on</button>
              </div>
            </Note>
          )}
        </>
      )}
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
    </>
  )

  if (!forced) return <div className="stack">{body}</div>
  return (
    <div className="center-page">
      <Brand />
      <div className="panel">
        <h2>Set up two-step login</h2>
        {body}
        <button type="button" className="linkish" onClick={signOut}>Sign out</button>
      </div>
    </div>
  )
}
