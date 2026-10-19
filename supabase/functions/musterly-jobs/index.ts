// Musterly background jobs, run once a day by Supabase Cron.
// Today: deletes check-in photos older than each company's retention period.
// Later: WhatsApp alerts will run from here too.
//
// Setup (see README → "Daily background job"):
//   1. Create this function in Supabase → Edge Functions, named "musterly-jobs", with "Verify JWT" turned off.
//   2. Add a secret CRON_SECRET (any long random text) under Edge Functions → Secrets.
//   3. Schedule it daily in Supabase → Integrations → Cron, sending the header  x-cron-secret: <same text>.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to Edge Functions automatically.

import { createClient } from 'npm:@supabase/supabase-js@2'

const BUCKET = 'selfies'
const BATCH = 500

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET')
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return json({ error: 'Not allowed. Send the x-cron-secret header that matches the CRON_SECRET secret.' }, 401)
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })

  const report = { photosDeleted: 0, recordsCleared: 0, batches: 0, errors: [] as string[] }

  // Work in batches so a large backlog doesn't time out; stop after 20 batches and finish next run.
  for (let i = 0; i < 20; i++) {
    const { data, error } = await supabase.rpc('expired_photos', { p_limit: BATCH })
    if (error) {
      report.errors.push(`expired_photos: ${error.message}`)
      break
    }
    const rows = (data ?? []) as { attendance_id: string; selfie_path: string | null; group_photo_path: string | null }[]
    if (!rows.length) break
    report.batches++

    const paths = [...new Set(rows.flatMap((r) => [r.selfie_path, r.group_photo_path]).filter((p): p is string => !!p))]
    // Storage accepts up to 1000 paths per call.
    for (let j = 0; j < paths.length; j += 1000) {
      const chunk = paths.slice(j, j + 1000)
      const { data: removed, error: rmErr } = await supabase.storage.from(BUCKET).remove(chunk)
      if (rmErr) report.errors.push(`storage remove: ${rmErr.message}`)
      else report.photosDeleted += removed?.length ?? 0
    }

    // Clear the paths even if a file was already gone, so the row isn't picked up again.
    const { data: cleared, error: clrErr } = await supabase.rpc('forget_photos', { p_ids: rows.map((r) => r.attendance_id) })
    if (clrErr) {
      report.errors.push(`forget_photos: ${clrErr.message}`)
      break
    }
    report.recordsCleared += (cleared as number) ?? 0
    if (rows.length < BATCH) break
  }

  console.log('musterly-jobs', JSON.stringify(report))
  return json(report, report.errors.length ? 500 : 200)
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
