import type { ReactNode } from 'react'

export function Pill({ tone, children }: { tone: 'ok' | 'late' | 'bad' | 'off'; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>
}

export function Note({ tone, children }: { tone: 'ok' | 'bad' | 'info'; children: ReactNode }) {
  return (
    <div className={`msg ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted small">{label}</p>
}

export function initials(name: string) {
  return name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
}

export function Avatar({ name, src }: { name: string; src?: string | null }) {
  return <div className="avatar">{src ? <img src={src} alt={`Check-in selfie of ${name}`} /> : initials(name)}</div>
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
