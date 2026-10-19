import { useCallback, useEffect, useState } from 'react'
import { supabase, ATTENDANCE_COLS, type Attendance, type Office, type Shift } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { getFix, distanceM, type Fix } from '../../lib/geo'
import { friendly } from '../../lib/errors'
import { dateIn, timeIn, hm, hoursBetween } from '../../lib/time'
import { SelfieCapture } from '../../components/SelfieCapture'
import { QrScanner } from '../../components/QrScanner'
import { Note, Pill, Loading } from '../../components/ui'
import { useT } from '../../lib/i18n'

type Kind = 'in' | 'out'

export function ClockPage() {
  const { profile, company, userId, refresh } = useMember()
  const t = useT()
  const tz = company.timezone
  const today = dateIn(tz)

  const { data, loading, error, reload } = useAsync(async () => {
    const [att, shift, offices] = await Promise.all([
      supabase.from('attendance').select(ATTENDANCE_COLS).eq('user_id', userId).order('clock_in_at', { ascending: false }).limit(1),
      profile.shift_id
        ? supabase.from('shifts').select('id, company_id, name, start_time, end_time, grace_minutes').eq('id', profile.shift_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from('offices').select('id, company_id, name, lat, lng, radius_m').order('name'),
    ])
    return {
      last: (must(att) as Attendance[])[0] ?? null,
      shift: must(shift) as Shift | null,
      offices: must(offices) as Office[],
    }
  }, [userId, profile.shift_id])

  const [selfie, setSelfie] = useState<Blob | null>(null)
  const [selfiePath, setSelfiePath] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [scanFor, setScanFor] = useState<Kind | null>(null)
  const [fix, setFix] = useState<Fix | null>(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 20000)
    return () => clearInterval(t)
  }, [])

  const last = data?.last ?? null
  const open = last && !last.clock_out_at && Date.now() - new Date(last.clock_in_at).getTime() < 20 * 3600_000 ? last : null
  const doneToday = !open && last && last.work_date === today ? last : null
  const state: 'out' | 'in' | 'done' = open ? 'in' : doneToday ? 'done' : 'out'

  const nearest = fix && data?.offices.length
    ? data.offices
        .map((o) => ({ o, d: distanceM(fix.lat, fix.lng, o.lat, o.lng) }))
        .sort((a, b) => a.d - a.o.radius_m - (b.d - b.o.radius_m))[0]
    : null

  const clock = useCallback(
    async (kind: Kind, qr?: string) => {
      setMsg(null)
      try {
        let path = selfiePath
        if (kind === 'in') {
          if (!selfie && !path) throw new Error('NEEDS_SELFIE')
          if (!path && selfie) {
            setBusy(t('clk.uploading'))
            path = `${company.id}/${userId}/${today}-${Date.now()}.jpg`
            const up = await supabase.storage.from('selfies').upload(path, selfie, { contentType: 'image/jpeg', upsert: false })
            if (up.error) throw new Error(up.error.message)
            setSelfiePath(path)
          }
        }
        let args: Record<string, unknown> = {}
        if (qr) {
          args = { p_qr: qr }
        } else {
          setBusy(t('clk.locating'))
          const f = await getFix()
          setFix(f)
          args = { p_lat: f.lat, p_lng: f.lng, p_accuracy: Math.round(f.accuracy) }
        }
        setBusy(kind === 'in' ? t('clk.clockingIn') : t('clk.clockingOut'))
        const res =
          kind === 'in'
            ? await supabase.rpc('clock_in', { ...args, p_selfie_path: path })
            : await supabase.rpc('clock_out', args)
        if (res.error) throw new Error(res.error.message)
        const rec = res.data as Attendance
        const at = timeIn(tz, kind === 'in' ? rec.clock_in_at : rec.clock_out_at)
        const via = rec.in_method === 'qr' || qr ? t('via.qr') : t('via.location')
        if (kind === 'in') {
          setMsg(
            rec.is_late
              ? { tone: 'bad', text: t('clk.lateIn', { time: at, via }) }
              : { tone: 'ok', text: t('clk.okIn', { time: at, via }) },
          )
          setSelfie(null)
          setSelfiePath(null)
        } else {
          const h = hoursBetween(rec.clock_in_at, rec.clock_out_at)
          setMsg({ tone: 'ok', text: t('clk.okOut', { time: at, hours: h?.toFixed(1) ?? '0' }) })
        }
        await reload()
      } catch (e) {
        const f = friendly(e)
        setMsg({ tone: 'bad', text: f.text })
      } finally {
        setBusy(null)
      }
    },
    [selfie, selfiePath, company.id, userId, today, tz, reload, t],
  )

  const onScan = useCallback(
    (code: string) => {
      const k = scanFor
      setScanFor(null)
      if (k) clock(k, code)
    },
    [scanFor, clock],
  )

  async function accept() {
    setBusy(t('clk.saving'))
    const { error } = await supabase.rpc('accept_privacy_notice')
    setBusy(null)
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else await refresh()
  }

  if (loading && !data) return <Loading />
  if (error) return <Note tone="bad">{friendly(error).text}</Note>

  const shift = data!.shift
  const firstName = profile.full_name.split(' ')[0]

  return (
    <div className="stack">
      <section className="panel">
        <div className="row between">
          <div>
            <div className="label">{now.toLocaleDateString('en-IN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' })}</div>
            <h1 className="h-hello">{t('clk.hi', { name: firstName })}</h1>
            <div className="small muted">
              {shift ? <>{t('clk.shift', { name: shift.name })} · <span className="mono">{hm(shift.start_time)}–{hm(shift.end_time)}</span></> : t('clk.noShift')}
            </div>
          </div>
          <div className="clock num">{timeIn(tz, now.toISOString())}</div>
        </div>
        <div>
          {state === 'in' && <Pill tone={open!.is_late ? 'late' : 'ok'}>{t(open!.is_late ? 'clk.lateAt' : 'clk.inAt', { time: timeIn(tz, open!.clock_in_at) })}</Pill>}
          {state === 'done' && <Pill tone="off">{t('clk.dayDone')}</Pill>}
          {state === 'out' && <Pill tone="off">{t('clk.notIn')}</Pill>}
        </div>
      </section>

      {!profile.consented_at ? (
        <section className="panel">
          <h2>{t('clk.beforeTitle')}</h2>
          <ul className="notice-list">
            <li>{t('clk.notice1')}</li>
            <li>{t('clk.notice2', { company: company.name })}</li>
            <li>{t('clk.notice3', { company: company.name })}</li>
          </ul>
          <button className="btn primary big" onClick={accept} disabled={!!busy}>{t('clk.understand')}</button>
          {msg && <Note tone={msg.tone}>{msg.text}</Note>}
        </section>
      ) : scanFor ? (
        <section className="panel">
          <h2>{t('clk.scanTitle')}</h2>
          <p className="small muted">{t('clk.scanHint')}</p>
          <QrScanner onResult={onScan} onCancel={() => setScanFor(null)} />
        </section>
      ) : state === 'done' ? (
        <section className="panel">
          <h2>{t('clk.doneTitle')}</h2>
          <p className="muted">
            {t('clk.doneBody', { hours: hoursBetween(doneToday!.clock_in_at, doneToday!.clock_out_at)?.toFixed(1) ?? '0', from: timeIn(tz, doneToday!.clock_in_at), to: timeIn(tz, doneToday!.clock_out_at) })}
          </p>
          {msg && <Note tone={msg.tone}>{msg.text}</Note>}
        </section>
      ) : (
        <section className="panel">
          {data!.offices.length === 0 && (
            <Note tone="info">{t('clk.noOffice')}</Note>
          )}
          {state === 'out' && (
            <div className="step">
              <div className="label">{t('clk.step1')}</div>
              <SelfieCapture onCapture={(b) => { setSelfie(b); setSelfiePath(null) }} />
            </div>
          )}
          <div className="step">
            {state === 'out' && <div className="label">{t('clk.step2')}</div>}
            <button className="btn primary big" disabled={!!busy || (state === 'out' && !selfie)} onClick={() => clock(state === 'out' ? 'in' : 'out')}>
              {busy ?? (state === 'out' ? t('clk.inGps') : t('clk.outGps'))}
            </button>
            <button className="btn" disabled={!!busy || (state === 'out' && !selfie)} onClick={() => setScanFor(state === 'out' ? 'in' : 'out')}>
              {t('clk.useQr')}
            </button>
          </div>
          {msg && <Note tone={msg.tone}>{msg.text}</Note>}
          {nearest && (
            <FenceView distance={nearest.d} radius={nearest.o.radius_m} name={nearest.o.name} accuracy={fix!.accuracy} />
          )}
        </section>
      )}
    </div>
  )
}

function FenceView({ distance, radius, name, accuracy }: { distance: number; radius: number; name: string; accuracy: number }) {
  const t = useT()
  const inside = distance <= radius
  const R = 70
  // Inside: true to scale. Outside: pinned just past the ring so it stays visible.
  const d = inside ? (distance / radius) * R : R + 10
  const x = 90 + Math.cos(-0.6) * d
  const y = 90 + Math.sin(-0.6) * d
  return (
    <div className="fence">
      <svg viewBox="0 0 180 180" role="img" aria-label={`${Math.round(distance)} metres from ${name}`}>
        <circle cx="90" cy="90" r="88" fill="var(--sunk)" />
        <circle cx="90" cy="90" r={R} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" strokeDasharray="5 4" />
        <rect x="84" y="84" width="12" height="12" rx="3" fill="var(--accent)" />
        <circle cx={x} cy={y} r="6" fill={inside ? 'var(--accent)' : 'var(--bad)'} stroke="var(--surface)" strokeWidth="2" />
      </svg>
      <div>
        <div className="label">{name}</div>
        <div className="fence-status" style={{ color: inside ? 'var(--accent)' : 'var(--bad)' }}>
          {t(inside ? 'fence.inside' : 'fence.outside')}
        </div>
        <div className="small muted">
          <span className="num">{t('fence.detail', { d: Math.round(distance), r: radius, a: Math.round(accuracy) })}</span>
        </div>
      </div>
    </div>
  )
}
