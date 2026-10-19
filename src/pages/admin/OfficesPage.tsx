import { useState, type FormEvent } from 'react'
import { supabase, type Office } from '../../supabase'
import { useMember } from '../../lib/session'
import { useAsync, must } from '../../lib/useAsync'
import { getFix } from '../../lib/geo'
import { friendly } from '../../lib/errors'
import { Loading, Note } from '../../components/ui'

const COLS = 'id, company_id, name, lat, lng, radius_m'

export function OfficesPage() {
  const { company } = useMember()
  const { data, loading, error, reload } = useAsync(
    async () => must(await supabase.from('offices').select(COLS).order('name')) as Office[],
    [],
  )
  const [editing, setEditing] = useState<Office | null>(null)

  return (
    <div className="stack">
      <section className="panel">
        <h2>Offices</h2>
        <p className="small muted">People can clock in when their phone is inside any office's zone, or by scanning that office's QR screen.</p>
        {loading && !data ? <Loading /> : error ? <Note tone="bad">{friendly(error).text}</Note> : data!.length === 0 ? (
          <Note tone="info">Add your first office below. Until then, nobody can clock in.</Note>
        ) : (
          <div className="people">
            {data!.map((o) => (
              <div key={o.id} className="office">
                <div className="minw0">
                  <div>{o.name}</div>
                  <div className="meta mono">{o.lat.toFixed(5)}, {o.lng.toFixed(5)} · {o.radius_m} m zone</div>
                  <a className="small" href={`https://www.google.com/maps?q=${o.lat},${o.lng}`} target="_blank" rel="noreferrer">Check on Google Maps</a>
                </div>
                <div className="row end">
                  <a className="btn" href={`#/admin/qr/${o.id}`}>Open QR screen</a>
                  <button className="btn ghost" onClick={() => setEditing(o)}>Edit</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <OfficeForm key={editing?.id ?? 'new'} companyId={company.id} office={editing} onDone={() => { setEditing(null); reload() }} />
    </div>
  )
}

function OfficeForm({ companyId, office, onDone }: { companyId: string; office: Office | null; onDone: () => void }) {
  const [name, setName] = useState(office?.name ?? '')
  const [lat, setLat] = useState(office ? String(office.lat) : '')
  const [lng, setLng] = useState(office ? String(office.lng) : '')
  const [radius, setRadius] = useState(office?.radius_m ?? 150)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null)
  const [locating, setLocating] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)

  async function useHere() {
    setLocating(true)
    setMsg(null)
    try {
      const f = await getFix()
      setLat(f.lat.toFixed(6))
      setLng(f.lng.toFixed(6))
      setMsg({ tone: 'info', text: `Location captured, accurate to about ${Math.round(f.accuracy)} m.${f.accuracy > 50 ? ' For a better fix, try again near a window.' : ''}` })
    } catch (e) {
      setMsg({ tone: 'bad', text: friendly(e).text.replace(/,? or scan the office QR code/, '') })
    } finally {
      setLocating(false)
    }
  }

  function pasteCoords(text: string) {
    const m = text.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/)
    if (m) {
      setLat(m[1])
      setLng(m[2])
      return true
    }
    return false
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const la = Number(lat)
    const ln = Number(lng)
    if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180 || (la === 0 && ln === 0)) {
      setMsg({ tone: 'bad', text: 'Enter a valid latitude and longitude, or tap "Use my current location" while you are at the office.' })
      return
    }
    const row = { name: name.trim(), lat: la, lng: ln, radius_m: radius }
    const res = office
      ? await supabase.from('offices').update(row).eq('id', office.id)
      : await supabase.from('offices').insert({ ...row, company_id: companyId })
    if (res.error) setMsg({ tone: 'bad', text: friendly(res.error).text })
    else onDone()
  }

  async function remove() {
    if (!office) return
    const { error } = await supabase.from('offices').delete().eq('id', office.id)
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else onDone()
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>{office ? `Edit ${office.name}` : 'Add an office'}</h2>
      <p className="small muted">
        Easiest: stand inside the office and tap "Use my current location". You can also copy coordinates from Google Maps (long-press
        the building) and paste them into Latitude.
      </p>
      <label className="field">Office name<input id="office-name" required value={name} placeholder="Head office, MG Road" onChange={(e) => setName(e.target.value)} /></label>
      <div className="row">
        <button type="button" className="btn" onClick={useHere} disabled={locating}>{locating ? 'Finding location…' : 'Use my current location'}</button>
      </div>
      <div className="row">
        <label className="field">Latitude
          <input id="office-lat" className="mono" inputMode="decimal" required value={lat}
            onChange={(e) => { if (!pasteCoords(e.target.value)) setLat(e.target.value) }} />
        </label>
        <label className="field">Longitude
          <input id="office-lng" className="mono" inputMode="decimal" required value={lng} onChange={(e) => setLng(e.target.value)} />
        </label>
      </div>
      <label className="field">Zone radius: <span className="num">{radius} m</span>
        <input id="office-radius" type="range" min={25} max={1000} step={5} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
        <span className="small muted">100–200 m suits most buildings. Go bigger for large sites or campuses.</span>
      </label>
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
      <div className="row">
        <button className="btn primary">{office ? 'Save office' : 'Add office'}</button>
        {office && <button type="button" className="btn" onClick={onDone}>Cancel</button>}
        {office && !confirmDel && <button type="button" className="btn ghost" onClick={() => setConfirmDel(true)}>Delete</button>}
      </div>
      {office && confirmDel && (
        <Note tone="bad">
          People will no longer be able to clock in at {office.name}. Past records are kept.{' '}
          <button type="button" className="btn" onClick={remove}>Delete office</button>{' '}
          <button type="button" className="btn" onClick={() => setConfirmDel(false)}>Keep it</button>
        </Note>
      )}
    </form>
  )
}
