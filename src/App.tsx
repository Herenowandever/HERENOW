import { useRoute } from './lib/router'
import { useSession } from './lib/session'
import { useT, LangSwitch } from './lib/i18n'
import { isConfigured, configError } from './supabase'
import { Layout, Brand } from './components/Layout'
import { AuthPage } from './pages/AuthPage'
import { Onboard } from './pages/Onboard'
import { ClockPage } from './pages/employee/ClockPage'
import { HistoryPage } from './pages/employee/HistoryPage'
import { CrewPage } from './pages/CrewPage'
import { AttendancePage } from './pages/admin/AttendancePage'
import { TeamPage } from './pages/admin/TeamPage'
import { ShiftsPage } from './pages/admin/ShiftsPage'
import { OfficesPage } from './pages/admin/OfficesPage'
import { QrScreen } from './pages/admin/QrScreen'
import { ReportsPage } from './pages/admin/ReportsPage'
import { SettingsPage } from './pages/admin/SettingsPage'

export function App() {
  const route = useRoute()
  const t = useT()
  const { loading, dbError, session, profile, company, signOut } = useSession()

  if (!isConfigured) {
    return (
      <div className="center-page">
        <Brand />
        <div className="panel">
          <h2>Almost there</h2>
          <p className="msg bad">{configError}</p>
          <p>
            Fix this in Vercel under <strong>Settings → Environment Variables</strong>, then open <strong>Deployments</strong> and
            choose <strong>Redeploy</strong> on the latest one. The values come from Supabase under <strong>Project Settings → API Keys</strong>.
          </p>
        </div>
      </div>
    )
  }

  if (loading) return <div className="center-page"><Brand /><p className="muted">{t('loading')}</p></div>
  if (!session) return <AuthPage />

  if (dbError) {
    return (
      <div className="center-page">
        <Brand />
        <div className="panel">
          <h2>The database needs an update</h2>
          <p>
            This version of HereNow needs the newest database changes. In Supabase, open <strong>SQL Editor</strong>, paste the
            contents of the newest file in <code>supabase/migrations</code> (for example <code>0003_crews_and_wages.sql</code>),
            and click <strong>Run</strong>. Then reload this page.
          </p>
          <p className="small muted mono break">{dbError}</p>
          <div className="row">
            <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
            <button className="btn" onClick={signOut}>{t('signOut')}</button>
          </div>
        </div>
      </div>
    )
  }

  if (!profile || !company) return <Onboard joinCode={route.query.get('code') ?? ''} />

  if (!profile.active) {
    return (
      <div className="center-page">
        <div className="row between"><Brand sub={company.name} /><LangSwitch /></div>
        <div className="panel">
          <h2>{t('gate.offTitle')}</h2>
          <p>{t('gate.offBody', { company: company.name })}</p>
          <button className="btn" onClick={signOut}>{t('signOut')}</button>
        </div>
      </div>
    )
  }

  const p = route.path
  const isAdmin = profile.role === 'admin'
  const canCrew = isAdmin || profile.role === 'supervisor'

  // Full-screen reception display, no navigation.
  if (isAdmin && p.startsWith('/admin/qr/')) return <QrScreen officeId={p.split('/')[3]} />

  let page
  if (p === '/history') page = <HistoryPage />
  else if (canCrew && p === '/crew') page = <CrewPage />
  else if (isAdmin && p === '/admin') page = <AttendancePage />
  else if (isAdmin && p === '/admin/team') page = <TeamPage />
  else if (isAdmin && p === '/admin/shifts') page = <ShiftsPage />
  else if (isAdmin && p === '/admin/offices') page = <OfficesPage />
  else if (isAdmin && p === '/admin/reports') page = <ReportsPage />
  else if (isAdmin && p === '/admin/settings') page = <SettingsPage />
  else page = <ClockPage />

  return <Layout path={p}>{page}</Layout>
}
