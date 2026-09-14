// §5.4 token refresh + auth_failed probe. Both housekeeping steps (task 0, under the lease).
import { sql } from './db.js'
import type { Tick } from './db.js'
import { type RunContext, type Source, connectors, redact } from './connectors/index.js'
import { contextFor, refreshOne } from './run.js'
import { shopifyEndpoint } from './connectors/shopify-url.js'

/** Only google_oauth_refresh has an expires_at, so the predicate skips the other kinds by itself. */
export async function refreshTokens(t: Tick): Promise<number> {
  const due = await sql<{ client_id: string; source: Source }>(
    `select client_id, source from data.source_tokens
     where status = 'active' and expires_at is not null and expires_at < now() + interval '10 minutes'`)
  let n = 0
  for (const row of due.rows) {
    const conn = connectors[row.source]
    if (!conn?.refreshToken) continue
    try {
      if (await refreshOne(await contextFor(t, row.client_id, row.source), conn)) n++
    } catch (e) {
      t.log('token_refresh_failed', { client: row.client_id, source: row.source, error: String(e) })
    }
  }
  return n
}

/** One cheap authenticated call per source; §5.4. */
const google = (ctx: RunContext) => ctx.fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
  headers: { Authorization: `Bearer ${ctx.token.secret}` },
})
const PROBES: Record<Source, (ctx: RunContext) => Promise<Response>> = {
  shopify: ctx => ctx.fetch(shopifyEndpoint(ctx.config.shop), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': ctx.token.secret },
    body: JSON.stringify({ query: '{ shop { id } }' }),
  }),
  meta: ctx => ctx.fetch(`https://graph.facebook.com/v21.0/me?fields=id&access_token=${encodeURIComponent(ctx.token.secret)}`),
  monday: ctx => ctx.fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: ctx.token.secret },
    body: JSON.stringify({ query: '{ me { id } }' }),
  }),
  meet: google,
  drive: google,
}

/** A token mis-classified during an outage recovers within an hour; a failure bumps updated_at so the probe stays hourly. */
export async function probeAuthFailed(t: Tick): Promise<number> {
  const rows = await sql<{ client_id: string; source: Source }>(
    `select client_id, source from data.source_tokens
     where status = 'auth_failed' and updated_at < now() - interval '1 hour' limit 50`)
  let ok = 0
  for (const row of rows.rows) {
    let good = false, detail: string | null = null
    try {
      const ctx = await contextFor(t, row.client_id, row.source)
      const r = await PROBES[row.source](ctx)
      const body = await r.text()
      good = r.ok && !/USER_UNAUTHORIZED|ACCESS_DENIED|"error"\s*:/.test(body)
      if (!good) detail = redact(`probe HTTP ${r.status}`)
    } catch (e) {
      detail = redact(e instanceof Error ? e.message : String(e))
    }
    if (good) ok++
    await sql(
      `update data.source_tokens set status = case when $3 then 'active' else status end,
         status_detail = case when $3 then null else coalesce($4, status_detail) end,
         updated_at = now()
       where client_id = $1 and source = $2`,
      [row.client_id, row.source, good, detail])
  }
  return ok
}
