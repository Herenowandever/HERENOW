import { useRoute } from './lib/router'
import { useSession } from './lib/session'
import { isConfigured } from './supabase'
import { Layout, Brand } from './components/Layout'
import { AuthPage } from './pages/AuthPage'
import { Onboard } from './pages/Onboard'
import { ClockPage } from './pages/employee/ClockPage'
import { HistoryPage } from './pages/employee/HistoryPage'
import { AttendancePage } from './pages/admin/AttendancePage'
import { TeamPage } from './pages/admin/TeamPage'
import { ShiftsPage } from './pages/admin/ShiftsPage'
import { OfficesPage } from './pages/admin/OfficesPage'
import { QrScreen } from './pages/admin/QrScreen'
import { ReportsPage } from './pages/admin/ReportsPage'
import { SettingsPage } from './pages/admin/SettingsPage'

export function App() {
  const route = useRoute()
  const { loading, session, profile, company, signOut } = useSession()

  if (!isConfigured) {
    return (
      <div className="center-page">
        <Brand />
        <div className="panel">
          <h2>Almost there</h2>
          <p>
            Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to your environment, then restart or
            redeploy. The README explains where to find them.
          </p>
        </div>
      </div>
    )
  }

  if (loading) return <div className="center-page"><Brand /><p className="muted">Loading…</p></div>
  if (!session) return <AuthPage />
  if (!profile || !company) return <Onboard joinCode={route.query.get('code') ?? ''} />

  if (!profile.active) {
    return (
      <div className="center-page">
        <Brand sub={company.name} />
        <div className="panel">
          <h2>Your access is turned off</h2>
          <p>An admin at {company.name} has deactivated your account. Ask them to turn it back on if this is a mistake.</p>
          <button className="btn" onClick={signOut}>Sign out</button>
        </div>
      </div>
    )
  }

  const p = route.path
  const isAdmin = profile.role === 'admin'

  // Full-screen reception display, no navigation.
  if (isAdmin && p.startsWith('/admin/qr/')) return <QrScreen officeId={p.split('/')[3]} />

  let page
  if (p === '/history') page = <HistoryPage />
  else if (isAdmin && p === '/admin') page = <AttendancePage />
  else if (isAdmin && p === '/admin/team') page = <TeamPage />
  else if (isAdmin && p === '/admin/shifts') page = <ShiftsPage />
  else if (isAdmin && p === '/admin/offices') page = <OfficesPage />
  else if (isAdmin && p === '/admin/reports') page = <ReportsPage />
  else if (isAdmin && p === '/admin/settings') page = <SettingsPage />
  else page = <ClockPage />

  return <Layout path={p}>{page}</Layout>
}
