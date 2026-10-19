import { useCallback, useMemo, useState } from 'react'
import { supabase, ATTENDANCE_COLS, PROFILE_COLS, type Attendance, type Office, type Profile } from '../supabase'
import { useMember } from '../lib/session'
import { useAsync, must } from '../lib/useAsync'
import { useT } from '../lib/i18n'
import { getFix } from '../lib/geo'
import { friendly } from '../lib/errors'
import { dateIn, timeIn } from '../lib/time'
import { SelfieCapture } from '../components/SelfieCapture'
import { QrScanner } from '../components/QrScanner'
import { Avatar, Loading, Note, Pill } from '../components/ui'

type Status = 'in' | 'late' | 'out' | 'done'
interface Result { person: string; full_name: string; result: string }

// Supervisors mark their site's crew in or out with one group photo. Admins can do it for any site.
export function CrewPage() {
  const { profile, company, userId } = useMember()
  const t = useT()
  const tz = company.timezone
  const isAdmin = profile.role === 'admin'
  const [site, setSite] = useState<string>(profile.office_id ?? '')

  const { data, loading, error, reload } = useAsync(async () => {
    const today = dateIn(tz)
    const yesterday = dateIn(tz, new Date(Date.now() - 86400000))
    const [offices, people, att] = await Promise.all([
      supabase.from('offices').select('id, company_id, name, lat, lng, radius_m').order('name'),
      supabase.from('profiles').select(PROFILE_COLS).eq('active', true).order('full_name'),
      supabase.from('attendance').select(ATTENDANCE_COLS).in('work_date', [yesterday, today]),
    ])
    return { offices: must(offices) as Office[], people: must(people) as Profile[], att: must(att) as Attendance[], today }
  }, [tz])

  const offices = data?.offices ?? []
  const activeSite = isAdmin ? site || offices[0]?.id || '' : profile.office_id ?? ''
  const siteName = offices.find((o) => o.id === activeSite)?.name ?? ''

  const crew = useMemo(() => {
    if (!data) return []
    const now = Date.now()
    return data.people
      .filter((p) => p.id !== userId && p.role !== 'admin' && p.office_id === activeSite)
      .map((p) => {
        const recs = data.att.filter((a) => a.user_id === p.id).sort((a, b) => b.clock_in_at.localeCompare(a.clock_in_at))
        const last = recs[0]
        let status: Status = 'out'
        if (last && !last.clock_out_at && now - new Date(last.clock_in_at).getTime() < 20 * 3600_000) status = last.is_late ? 'late' : 'in'
        else if (last && last.work_date === data.today) status = 'done'
        return { p, last, status }
      })
  }, [data, activeSite, userId])

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [results, setResults] = useState<Result[] | null>(null)
  const [scanFor, setScanFor] = useState<'in' | 'out' | null>(null)
  const [camKey, setCamKey] = useState(0)

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const selectWhere = (pred: (s: Status) => boolean) => setSelected(new Set(crew.filter((c) => pred(c.status)).map((c) => c.p.id)))

  const toMarkIn = crew.filter((c) => selected.has(c.p.id) && c.status === 'out').map((c) => c.p.id)
  const toMarkOut = crew.filter((c) => selected.has(c.p.id) && (c.status === 'in' || c.status === 'late')).map((c) => c.p.id)

  const mark = useCallback(
    async (kind: 'in' | 'out', qr?: string) => {
      const ids = kind === 'in' ? toMarkIn : toMarkOut
      setMsg(null)
      setResults(null)
      try {
        if (!ids.length) throw new Error('NOBODY_SELECTED')
        if (!isAdmin && !photo) throw new Error('NEEDS_PHOTO')
        let path: string | null = null
        if (photo) {
          setBusy(t('clk.uploading'))
          path = `${company.id}/${userId}/crew-${dateIn(tz)}-${Date.now()}.jpg`
          const up = await supabase.storage.from('selfies').upload(path, photo, { contentType: 'image/jpeg' })
          if (up.error) throw new Error(up.error.message)
        }
        let loc: Record<string, unknown> = {}
        if (!isAdmin) {
          if (qr) loc = { p_qr: qr }
          else {
            setBusy(t('clk.locating'))
            const f = await getFix()
            loc = { p_lat: f.lat, p_lng: f.lng, p_accuracy: Math.round(f.accuracy) }
          }
        }
        setBusy(t('crew.marking'))
        const res = await supabase.rpc('crew_mark', { p_people: ids, p_kind: kind, p_photo_path: path, ...loc })
        if (res.error) throw new Error(res.error.message)
        const rows = (res.data ?? []) as Result[]
        const ok = rows.filter((r) => r.result === 'ok' || r.result === 'late').length
        setResults(rows)
        setMsg({ tone: ok === rows.length ? 'ok' : 'bad', text: t('crew.result', { ok, n: rows.length }) })
        setSelected(new Set())
        setPhoto(null)
        setCamKey((k) => k + 1)
        await reload()
      } catch (e) {
        setMsg({ tone: 'bad', text: friendly(e).text })
      } finally {
        setBusy(null)
      }
    },
    [toMarkIn, toMarkOut, isAdmin, photo, company.id, userId, tz, t, reload],
  )

  const onScan = useCallback((code: string) => {
    const k = scanFor
    setScanFor(null)
    if (k) mark(k, code)
  }, [scanFor, mark])

  if (loading && !data) return <Loading label={t('loading')} />
  if (error) return <Note tone="bad">{friendly(error).text}</Note>
  if (!isAdmin && !profile.office_id) return <Note tone="info">{t('crew.noSite')}</Note>
  if (isAdmin && offices.length === 0) return <Note tone="info">{t('crew.noSites')}</Note>

  const counts = {
    in: crew.filter((c) => c.status === 'in' || c.status === 'late').length,
    out: crew.filter((c) => c.status === 'out').length,
    done: crew.filter((c) => c.status === 'done').length,
  }
  const tone: Record<Status, 'ok' | 'late' | 'bad' | 'off'> = { in: 'ok', late: 'late', out: 'bad', done: 'off' }
  const label: Record<Status, string> = { in: 'crew.status.in', late: 'crew.status.late', out: 'crew.status.out', done: 'crew.status.done' }

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h2>{t('crew.title', { site: siteName })}</h2>
          <div className="small muted">{t('crew.stats', counts)}</div>
          {isAdmin && <a className="small" href="#/admin/team">Add or remove people on the Team page</a>}
        </div>
        {isAdmin && (
          <label className="field site-pick">{t('crew.site')}
            <select id="crew-site" value={activeSite} onChange={(e) => { setSite(e.target.value); setSelected(new Set()); setResults(null) }}>
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {scanFor ? (
        <section className="panel">
          <h2>{t('clk.scanTitle')}</h2>
          <QrScanner onResult={onScan} onCancel={() => setScanFor(null)} />
        </section>
      ) : (
        <section className="panel">
          {crew.length === 0 ? (
            <p className="muted">{t('crew.empty')}</p>
          ) : (
            <>
              <div className="row">
                <button className="btn small-btn" onClick={() => selectWhere((s) => s === 'out')}>{t('crew.selectNotIn')}</button>
                <button className="btn small-btn" onClick={() => selectWhere((s) => s === 'in' || s === 'late')}>{t('crew.selectOnSite')}</button>
                {selected.size > 0 && <button className="btn ghost small-btn" onClick={() => setSelected(new Set())}>{t('crew.clear')}</button>}
              </div>
              <ul className="crew-list">
                {crew.map(({ p, last, status }) => (
                  <li key={p.id}>
                    <label className={`crew-row ${selected.has(p.id) ? 'sel' : ''}`}>
                      <input type="checkbox" id={`crew-${p.id}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} disabled={status === 'done'} />
                      <Avatar name={p.full_name} />
                      <span className="minw0">
                        <span className="crew-name">{p.full_name}</span>
                        <span className="meta">
                          {p.job_title ?? ''}{!p.has_login && <> · {t('crew.noPhone')}</>}
                          {last && status !== 'out' && <> · <span className="mono">{timeIn(tz, last.clock_in_at)}{last.clock_out_at ? `–${timeIn(tz, last.clock_out_at)}` : ''}</span></>}
                        </span>
                      </span>
                      <Pill tone={tone[status]}>{t(label[status])}</Pill>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}

          {crew.length > 0 && (
            <div className="step">
              <div className="label">{t('crew.photoStep')}</div>
              <p className="small muted">{isAdmin ? t('crew.adminNote') : t('crew.photoHint')}</p>
              <SelfieCapture key={camKey} facing="environment" onCapture={setPhoto} />
              <div className="row">
                <button className="btn primary" disabled={!!busy || !toMarkIn.length || (!isAdmin && !photo)} onClick={() => mark('in')}>
                  {busy ?? t('crew.markIn', { n: toMarkIn.length })}
                </button>
                <button className="btn" disabled={!!busy || !toMarkOut.length || (!isAdmin && !photo)} onClick={() => mark('out')}>
                  {t('crew.markOut', { n: toMarkOut.length })}
                </button>
              </div>
              {!isAdmin && (
                <button className="linkish" disabled={!!busy || !photo || (!toMarkIn.length && !toMarkOut.length)}
                  onClick={() => setScanFor(toMarkIn.length ? 'in' : 'out')}>
                  {t('crew.useQr')}
                </button>
              )}
            </div>
          )}

          {msg && <Note tone={msg.tone}>{msg.text}</Note>}
          {results && results.some((r) => r.result !== 'ok' && r.result !== 'late') && (
            <ul className="result-list">
              {results.map((r) => (
                <li key={r.person}><span>{r.full_name}</span><span className="muted">{t(`res.${r.result}`)}</span></li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
