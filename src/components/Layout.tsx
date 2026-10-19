import type { ReactNode } from 'react'
import { useSession } from '../lib/session'

interface NavItem {
  path: string
  label: string
}

const EMPLOYEE_NAV: NavItem[] = [
  { path: '/', label: 'Clock in' },
  { path: '/history', label: 'My history' },
]

const ADMIN_NAV: NavItem[] = [
  { path: '/', label: 'Clock in' },
  { path: '/admin', label: 'Attendance' },
  { path: '/admin/team', label: 'Team' },
  { path: '/admin/shifts', label: 'Shifts' },
  { path: '/admin/offices', label: 'Offices & QR' },
  { path: '/admin/reports', label: 'Reports' },
  { path: '/admin/settings', label: 'Company' },
]

export function Brand({ sub }: { sub?: string }) {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true" />
      <div>
        <div className="brand-name">HereNow</div>
        {sub && <div className="brand-sub">{sub}</div>}
      </div>
    </div>
  )
}

export function Layout({ path, children }: { path: string; children: ReactNode }) {
  const { profile, company, signOut } = useSession()
  const nav = profile?.role === 'admin' ? ADMIN_NAV : EMPLOYEE_NAV
  const active = (p: string) => (p === '/' ? path === '/' : p === '/admin' ? path === '/admin' : path.startsWith(p))

  return (
    <div className="shell">
      <header className="topbar">
        <Brand sub={company?.name} />
        <div className="row">
          <span className="small muted who">{profile?.full_name}</span>
          <button className="btn ghost" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <nav className="nav" aria-label="Main">
        {nav.map((n) => (
          <a key={n.path} href={`#${n.path}`} aria-current={active(n.path) ? 'page' : undefined}>
            {n.label}
          </a>
        ))}
      </nav>
      <main className="page">{children}</main>
    </div>
  )
}
