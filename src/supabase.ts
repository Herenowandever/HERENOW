import { createClient } from '@supabase/supabase-js'

// Trim and strip quotes people often paste by accident.
const clean = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '') : '')
const url = clean(import.meta.env.VITE_SUPABASE_URL)
const key = clean(import.meta.env.VITE_SUPABASE_ANON_KEY)

function checkConfig(): string | null {
  if (!url && !key) return 'Neither VITE_SUPABASE_URL nor VITE_SUPABASE_ANON_KEY is set.'
  if (!url) return 'VITE_SUPABASE_URL is not set.'
  if (!key) return 'VITE_SUPABASE_ANON_KEY is not set.'
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return `VITE_SUPABASE_URL should be a web address like https://abcdefgh.supabase.co, but it starts with "${url.slice(0, 12)}…". Check you didn't swap the two values.`
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') return 'VITE_SUPABASE_URL must start with https://'
  if (key.startsWith('http')) return 'VITE_SUPABASE_ANON_KEY contains a web address. It should be the long key, not the URL. Check you didn\'t swap the two values.'
  if (key.startsWith('sb_secret_') || /service_role/.test(atobSafe(key.split('.')[1] ?? ''))) {
    return 'VITE_SUPABASE_ANON_KEY is your secret service key. Replace it with the anon public (or Publishable) key, and keep the secret key private.'
  }
  return null
}
function atobSafe(s: string) {
  try {
    return atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return ''
  }
}

export const configError = checkConfig()
export const isConfigured = configError === null

export const supabase = createClient(isConfigured ? url : 'https://not-configured.supabase.co', isConfigured ? key : 'not-configured', {
  auth: { persistSession: true, autoRefreshToken: true },
})

export type Role = 'admin' | 'employee'

export interface Profile {
  id: string
  company_id: string
  full_name: string
  job_title: string | null
  role: Role
  shift_id: string | null
  active: boolean
  consented_at: string | null
}

export interface Company {
  id: string
  name: string
  timezone: string
  join_code: string
}

export interface Shift {
  id: string
  company_id: string
  name: string
  start_time: string
  end_time: string
  grace_minutes: number
}

export interface Office {
  id: string
  company_id: string
  name: string
  lat: number
  lng: number
  radius_m: number
}

export interface Attendance {
  id: string
  user_id: string
  work_date: string
  office_id: string | null
  clock_in_at: string
  clock_out_at: string | null
  in_method: 'gps' | 'qr'
  out_method: 'gps' | 'qr' | null
  in_distance_m: number | null
  selfie_path: string | null
  shift_start: string | null
  shift_end: string | null
  is_late: boolean
  edited_by: string | null
}

export const PROFILE_COLS = 'id, company_id, full_name, job_title, role, shift_id, active, consented_at'
export const ATTENDANCE_COLS =
  'id, user_id, work_date, office_id, clock_in_at, clock_out_at, in_method, out_method, in_distance_m, selfie_path, shift_start, shift_end, is_late, edited_by'
