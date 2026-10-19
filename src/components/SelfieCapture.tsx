import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n'

interface Props {
  onCapture: (blob: Blob | null) => void
  /** 'user' for a selfie, 'environment' for a group photo with the back camera. */
  facing?: 'user' | 'environment'
}

// Live camera photo. Falls back to the phone's camera picker if live video isn't available.
export function SelfieCapture({ onCapture, facing = 'user' }: Props) {
  const t = useT()
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [mode, setMode] = useState<'idle' | 'live' | 'done' | 'fallback'>('idle')
  const [preview, setPreview] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const selfie = facing === 'user'
  const size = selfie ? 480 : 960

  const stop = () => {
    stream.current?.getTracks().forEach((tr) => tr.stop())
    stream.current = null
  }
  useEffect(() => stop, [])
  // Attach the camera once the <video> element exists.
  useEffect(() => {
    const v = video.current
    if (mode === 'live' && v && stream.current && v.srcObject !== stream.current) {
      v.srcObject = stream.current
      v.play().catch(() => {})
    }
  }, [mode])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  async function start() {
    setMsg(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setMode('fallback')
      return
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 } }, audio: false })
      setReady(false)
      setMode('live')
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      setMsg(denied ? t('cam.blocked') : null)
      setMode('fallback')
    }
  }

  function finish(blob: Blob | null) {
    if (preview) URL.revokeObjectURL(preview)
    setPreview(blob ? URL.createObjectURL(blob) : null)
    setMode(blob ? 'done' : 'idle')
    onCapture(blob)
  }

  // Selfies are cropped square; group photos keep their shape.
  function draw(src: CanvasImageSource, w: number, h: number, mirror: boolean) {
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')!
    if (selfie) {
      const k = Math.min(w, h)
      c.width = c.height = size
      if (mirror) { ctx.translate(size, 0); ctx.scale(-1, 1) }
      ctx.drawImage(src, (w - k) / 2, (h - k) / 2, k, k, 0, 0, size, size)
    } else {
      const scale = Math.min(1, size / Math.max(w, h))
      c.width = Math.round(w * scale)
      c.height = Math.round(h * scale)
      ctx.drawImage(src, 0, 0, c.width, c.height)
    }
    c.toBlob((b) => finish(b), 'image/jpeg', 0.8)
  }

  function snap() {
    const v = video.current
    if (!v || !v.videoWidth) return
    draw(v, v.videoWidth, v.videoHeight, selfie)
    stop()
  }

  function fromFile(f: File | undefined) {
    if (!f) return
    const img = new Image()
    const url = URL.createObjectURL(f)
    img.onload = () => {
      draw(img, img.width, img.height, false)
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      setMsg(t('cam.unreadable'))
    }
    img.src = url
  }

  return (
    <div className="selfie">
      {mode === 'live' && (
        <>
          <video ref={video} className={selfie ? 'selfie-video' : 'group-video'} playsInline muted aria-label={t('cam.alt')}
            onLoadedData={() => setReady(true)} onPlaying={() => setReady(true)} />
          <div className="row">
            <button className="btn primary" onClick={snap} disabled={!ready}>{ready ? t('cam.takePhoto') : t('cam.starting')}</button>
            <button className="btn" onClick={() => { stop(); setMode('idle') }}>{t('cancel')}</button>
          </div>
        </>
      )}
      {mode === 'done' && preview && (
        <div className="row">
          <img src={preview} className={selfie ? 'selfie-thumb' : 'group-thumb'} alt={t('cam.alt')} />
          <button className="btn" onClick={() => { finish(null); start() }}>{t('cam.retake')}</button>
        </div>
      )}
      {mode === 'idle' && <button className="btn" onClick={start}>{selfie ? t('cam.takeSelfie') : t('cam.groupPhoto')}</button>}
      {mode === 'fallback' && (
        <label className="btn file-btn">
          {t('cam.open')}
          <input type="file" accept="image/*" capture={facing} hidden onChange={(e) => fromFile(e.target.files?.[0])} />
        </label>
      )}
      {msg && <p className="small muted">{msg}</p>}
    </div>
  )
}
