import { useEffect, useRef, useState } from 'react'

interface Props {
  onCapture: (blob: Blob | null) => void
}

// Live front-camera selfie. Falls back to the phone's camera picker if live video isn't available.
export function SelfieCapture({ onCapture }: Props) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [mode, setMode] = useState<'idle' | 'live' | 'done' | 'fallback'>('idle')
  const [preview, setPreview] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }
  useEffect(() => stop, [])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  async function start() {
    setMsg(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setMode('fallback')
      return
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 } }, audio: false })
      setReady(false)
      setMode('live')
      requestAnimationFrame(() => {
        if (video.current && stream.current) {
          video.current.srcObject = stream.current
          video.current.play().catch(() => {})
        }
      })
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      setMsg(denied ? 'Camera access is blocked. Allow it in your browser settings, or use your camera app below.' : null)
      setMode('fallback')
    }
  }

  function finish(blob: Blob | null) {
    if (preview) URL.revokeObjectURL(preview)
    setPreview(blob ? URL.createObjectURL(blob) : null)
    setMode(blob ? 'done' : 'idle')
    onCapture(blob)
  }

  function snap() {
    const v = video.current
    if (!v || !v.videoWidth) return
    const size = Math.min(v.videoWidth, v.videoHeight)
    const out = 480
    const c = document.createElement('canvas')
    c.width = c.height = out
    const ctx = c.getContext('2d')!
    // Mirror so the saved photo matches what the person saw.
    ctx.translate(out, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(v, (v.videoWidth - size) / 2, (v.videoHeight - size) / 2, size, size, 0, 0, out, out)
    c.toBlob((b) => {
      stop()
      finish(b)
    }, 'image/jpeg', 0.8)
  }

  function fromFile(f: File | undefined) {
    if (!f) return
    const img = new Image()
    const url = URL.createObjectURL(f)
    img.onload = () => {
      const size = Math.min(img.width, img.height)
      const c = document.createElement('canvas')
      c.width = c.height = 480
      c.getContext('2d')!.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, 480, 480)
      URL.revokeObjectURL(url)
      c.toBlob((b) => finish(b), 'image/jpeg', 0.8)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      setMsg("That photo couldn't be read. Try taking it again.")
    }
    img.src = url
  }

  return (
    <div className="selfie">
      {mode === 'live' && (
        <>
          <video ref={video} className="selfie-video" playsInline muted aria-label="Front camera preview"
            onLoadedData={() => setReady(true)} onPlaying={() => setReady(true)} />
          <div className="row">
            <button className="btn primary" onClick={snap} disabled={!ready}>{ready ? 'Take photo' : 'Starting camera…'}</button>
            <button className="btn" onClick={() => { stop(); setMode('idle') }}>Cancel</button>
          </div>
        </>
      )}
      {mode === 'done' && preview && (
        <div className="row">
          <img src={preview} className="selfie-thumb" alt="Your check-in selfie" />
          <button className="btn" onClick={() => { finish(null); start() }}>Retake</button>
        </div>
      )}
      {mode === 'idle' && <button className="btn" onClick={start}>Take selfie</button>}
      {mode === 'fallback' && (
        <label className="btn file-btn">
          Open camera
          <input type="file" accept="image/*" capture="user" hidden onChange={(e) => fromFile(e.target.files?.[0])} />
        </label>
      )}
      {msg && <p className="small muted">{msg}</p>}
    </div>
  )
}
