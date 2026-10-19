import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { SessionProvider } from './lib/session'
import { LangProvider } from './lib/i18n'

// Shows the error on screen instead of a blank page, so problems are easy to report.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="center-page">
        <div className="panel">
          <h2>Musterly hit a problem</h2>
          <p className="msg bad mono break">{this.state.error.message}</p>
          <p className="small muted">Reload the page to try again. If it keeps happening, send this message to your Musterly admin or developer.</p>
          <button className="btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <LangProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </LangProvider>
    </ErrorBoundary>
  </StrictMode>,
)
