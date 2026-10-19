import { useState, type FormEvent } from 'react'
import { supabase } from '../../supabase'
import { useMember } from '../../lib/session'
import { friendly } from '../../lib/errors'
import { TIMEZONES } from '../../lib/time'
import { Note } from '../../components/ui'

export function SettingsPage() {
  const { company, refresh } = useMember()
  const [name, setName] = useState(company.name)
  const [tz, setTz] = useState(company.timezone)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase.from('companies').update({ name: name.trim(), timezone: tz }).eq('id', company.id)
    if (error) setMsg({ tone: 'bad', text: friendly(error).text })
    else {
      setMsg({ tone: 'ok', text: 'Company details saved.' })
      await refresh()
    }
  }

  const zones = TIMEZONES.includes(company.timezone) ? TIMEZONES : [company.timezone, ...TIMEZONES]

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Company</h2>
      <label className="field">Company name<input id="co-name" required value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Time zone
        <select id="co-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
          {zones.map((t) => <option key={t}>{t}</option>)}
        </select>
        <span className="small muted">Shift times, late marks and dates all follow this time zone.</span>
      </label>
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
      <div><button className="btn primary">Save</button></div>
    </form>
  )
}
