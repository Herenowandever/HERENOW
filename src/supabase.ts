import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key)

export const supabase = createClient(url || 'https://not-configured.supabase.co', key || 'not-configured', {
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
