import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { supabase } from '../../supabase'
import { useMember } from '../../lib/session'
import { friendly } from '../../lib/errors'
import { Brand } from '../../components/Layout'

// Full-screen display for a reception tablet. The code changes every day; the page refreshes it on its own.
export function QrScreen({ officeId }: { officeId: string }) {
  const { company } = useMember()
  const [name, setName] = useState('')
  const [code, setCode] = useState<string | null>(null)
  const [img, setImg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [o, c] = await Promise.all([
        supabase.from('offices').select('name').eq('id', officeId).maybeSingle(),
        supabase.rpc('office_qr_code', { p_office: officeId }),
      ])
      if (!alive) return
      if (c.error || !c.data) {
        setErr(c.error ? friendly(c.error).text : 'Office not found.')
        return
      }
      setErr(null)
      setName((o.data as { name: string } | null)?.name ?? '')
      setCode(c.data as string)
      setImg(await QRCode.toDataURL(`HERENOW:${officeId}:${c.data}`, { width: 720, margin: 1, errorCorrectionLevel: 'M' }))
    }
    load()
    const t = setInterval(load, 5 * 60 * 1000)

    // Keep the screen awake where the browser allows it.
    let lock: { release: () => Promise<void> } | null = null
    const nav = navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
    nav.wakeLock?.request('screen').then((l) => { lock = l }).catch(() => {})

    return () => {
      alive = false
      clearInterval(t)
      lock?.release().catch(() => {})
    }
  }, [officeId])

  return (
    <div className="qr-screen">
      <div className="row between qr-top">
        <Brand sub={company.name} />
        <a className="btn ghost" href="#/admin/offices">Back</a>
      </div>
      {err ? (
        <p className="msg bad">{err}</p>
      ) : (
        <div className="qr-body">
          <h1>Scan to clock in</h1>
          <div className="small muted">{name}</div>
          {img ? <img className="qr-img" src={img} alt={`QR code for ${name}`} /> : <div className="qr-img placeholder" />}
          <div className="label">Or type today's code</div>
          <div className="code big-code num">{code ?? '······'}</div>
          <p className="small muted">Open HereNow, tap "Scan office QR instead", and point your camera here. The code changes every day.</p>
        </div>
      )}
    </div>
  )
}
