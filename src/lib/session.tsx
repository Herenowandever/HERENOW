import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, PROFILE_COLS, type Company, type Profile } from '../supabase'

interface Ctx {
  loading: boolean
  dbError: string | null
  session: Session | null
  profile: Profile | null
  company: Company | null
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const SessionContext = createContext<Ctx | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [company, setCompany] = useState<Company | null>(null)
  const [loading, setLoading] = useState(true)
  const [dbError, setDbError] = useState<string | null>(null)

  const load = useCallback(async (s: Session | null) => {
    setSession(s)
    if (!s) {
      setProfile(null)
      setCompany(null)
      setLoading(false)
      return
    }
    const { data: p, error } = await supabase.from('profiles').select(PROFILE_COLS).eq('id', s.user.id).maybeSingle()
    if (error) {
      // Usually means a newer database update hasn't been run yet. Don't send the person to onboarding.
      setDbError(error.message)
      setLoading(false)
      return
    }
    setDbError(null)
    setProfile((p as Profile) ?? null)
    if (p) {
      const { data: c } = await supabase.from('companies').select('id, name, timezone, join_code').eq('id', (p as Profile).company_id).maybeSingle()
      setCompany((c as Company) ?? null)
    } else {
      setCompany(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => load(data.session))
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // Defer so we don't call Supabase inside its own auth callback.
        setTimeout(() => load(s), 0)
      }
    })
    return () => data.subscription.unsubscribe()
  }, [load])

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession()
    await load(data.session)
  }, [load])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    window.location.hash = '/'
  }, [])

  return (
    <SessionContext.Provider value={{ loading, dbError, session, profile, company, refresh, signOut }}>{children}</SessionContext.Provider>
  )
}

export function useSession(): Ctx {
  const c = useContext(SessionContext)
  if (!c) throw new Error('useSession outside SessionProvider')
  return c
}

/** For pages that only render once the person belongs to a company. */
export function useMember() {
  const s = useSession()
  return { ...s, profile: s.profile as Profile, company: s.company as Company, userId: s.session!.user.id }
}
