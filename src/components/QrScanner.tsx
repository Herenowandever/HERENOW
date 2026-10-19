import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { useT } from '../lib/i18n'

interface Props {
  onResult: (code: string) => void
  onCancel: () => void
}

interface Detector {
  detect(src: CanvasImageSource): Promise<{ rawValue: string }[]>
}

// Scans the reception QR with the back camera. Typing the 6-character code also works.
export function QrScanner({ onResult, onCancel }: Props) {
  const t = useT()
  const video = useRef<HTMLVideoElement>(null)
  const [typed, setTyped] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const done = useRef(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let cancelled = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector
    const detector = BD ? new BD({ formats: ['qr_code'] }) : null

    const found = (text: string) => {
      if (done.current) return
      done.current = true
      onResult(text)
    }

    const tick = async () => {
      const v = video.current
      if (cancelled || done.current || !v) return
      if (v.readyState >= 2 && v.videoWidth) {
        try {
          if (detector) {
            const codes = await detector.detect(v)
            if (codes[0]?.rawValue) return found(codes[0].rawValue)
          } else if (ctx) {
            const w = 480
            const h = Math.round((v.videoHeight / v.videoWidth) * w)
            canvas.width = w
            canvas.height = h
            ctx.drawImage(v, 0, 0, w, h)
            const img = ctx.getImageData(0, 0, w, h)
            const r = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })
            if (r?.data) return found(r.data)
          }
        } catch {
          /* keep scanning */
        }
      }
      raf = requestAnimationFrame(tick)
    }

    ;(async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMsg(t('qr.noCamera'))
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        if (video.current) {
          video.current.srcObject = stream
          await video.current.play().catch(() => {})
        }
        raf = requestAnimationFrame(tick)
      } catch {
        setMsg(t('qr.blocked'))
      }
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onResult])

  return (
    <div className="scanner">
      <div className="scanner-frame">
        <video ref={video} playsInline muted aria-label="Back camera preview for scanning" />
        <div className="scanner-target" aria-hidden="true" />
      </div>
      {msg && <p className="small muted">{msg}</p>}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          if (typed.trim().length >= 6) onResult(typed.trim().toUpperCase())
        }}
      >
        <input
          id="qr-code-typed"
          className="mono code-input"
          maxLength={6}
          placeholder={t('qr.typePh')}
          aria-label="Office code"
          value={typed}
          onChange={(e) => setTyped(e.target.value.toUpperCase())}
        />
        <button className="btn primary" type="submit" disabled={typed.trim().length < 6}>{t('qr.use')}</button>
        <button className="btn" type="button" onClick={onCancel}>{t('cancel')}</button>
      </form>
    </div>
  )
}
