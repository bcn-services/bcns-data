// onboard --slug --name --timezone [--sources shopify,meta,monday,meet,drive]  (DESIGN.md §5.10, §9)
// Inserts the client + smoke user, then per source: prompts for credentials, runs the §9 checklist
// (a failed item stops the script), writes source_tokens and connector_schedule from the connector's
// own defaults. Smoke password is printed once (no password-manager integration in this build).
import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { connectors, type Source } from '../worker/src/connectors/index.js'
import { checklist, type Creds } from './checklist.js'
import { die, pgClient, serviceClient, isMain, runMain } from './_lib.js'

// What the operator is asked for, per source (§4.2–§4.6 config + token shapes).
const PROMPTS: Record<Source, { config: string[]; secret: string; refresh?: string; attribute?: string }> = {
  shopify: { config: ['shop', 'admin_url'], secret: 'Admin API token' },
  meta: { config: ['act_id', 'ads_manager_url'], secret: 'system user token' },
  monday: { config: ['board_id', 'board_url'], secret: 'personal token' },
  meet: { config: ['folder_id', 'oauth_client_id', 'notes_url'], secret: 'access token (blank to mint from refresh)', refresh: 'refresh token', attribute: 'oauth_client_secret' },
  drive: { config: ['folder_id', 'oauth_client_id'], secret: 'access token (blank to mint from refresh)', refresh: 'refresh token', attribute: 'oauth_client_secret' },
}

export function backfillFrom(depth: string): string {
  if (depth === 'unbounded') return `'1970-01-01'::date`
  return `(current_date - interval '${depth === '0' ? '0 days' : depth}')::date`
}

export async function main(argv: string[], ask?: (q: string) => Promise<string>): Promise<void> {
  const { values } = parseArgs({ args: argv, options: {
    slug: { type: 'string' }, name: { type: 'string' }, timezone: { type: 'string' }, sources: { type: 'string' } } })
  const { slug, name, timezone } = values
  if (!slug || !name || !timezone) die('usage: onboard --slug <slug> --name <name> --timezone <tz> [--sources shopify,meta,monday,meet,drive]')
  const sources = (values.sources ?? '').split(',').map((s) => s.trim()).filter(Boolean) as Source[]
  for (const s of sources) if (!(s in connectors)) die(`unknown source: ${s}`)

  const db = pgClient()
  const rl = ask ? null : createInterface({ input: process.stdin, output: process.stdout })
  const question = ask ?? ((q: string) => rl!.question(q))
  try {
    const client = await db.query<{ id: string }>('insert into data.clients (slug, name, timezone) values ($1, $2, $3) returning id', [slug, name, timezone])
    const clientId = client.rows[0].id

    // U1
    const email = `smoke+${slug}@bcn-services.com`
    const password = randomBytes(18).toString('base64url')
    const admin = serviceClient()
    const { data: user, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error || !user.user) die(`create smoke user: ${error?.message}`)
    await db.query('insert into data.memberships (user_id, client_id, role, is_smoke) values ($1, $2, $3, true)', [user.user.id, clientId, 'member'])

    for (const source of sources) await attachSource(db, clientId, timezone, source, question)

    console.log(`onboarded ${slug} (${clientId})`)
    console.log(`smoke user: ${email}`)
    console.log(`smoke password (save now, shown once): ${password}`)
  } finally {
    rl?.close()
    await db.end()
  }
}

// One source: prompt, run the §9 checklist (throws before any write), upsert source_tokens + connector_schedule.
// Shared with add-source. Re-running rotates the token and resets its status; the schedule keeps its cursor.
export async function attachSource(db: ReturnType<typeof pgClient>, clientId: string, timezone: string, source: Source,
  question: (q: string) => Promise<string>): Promise<void> {
  const p = PROMPTS[source]
  const creds: Creds = { secret: '', config: {} }
  for (const k of p.config) creds.config[k] = await question(`${source} ${k}: `)
  creds.secret = await question(`${source} ${p.secret}: `)
  if (p.refresh) creds.refresh_secret = await question(`${source} ${p.refresh}: `)
  if (p.attribute) creds.attributes = { [p.attribute]: await question(`${source} ${p.attribute}: `) }
  const { config, warnings } = await checklist(source, timezone, creds)
  for (const w of warnings) console.warn(`warning ${w}`)
  const { access_token, expires_in, ...cfg } = config
  const conn = connectors[source]
  await db.query(
    `insert into data.source_tokens (client_id, source, kind, secret, refresh_secret, expires_at, attributes)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (client_id, source) do update set kind = excluded.kind, secret = excluded.secret, refresh_secret = excluded.refresh_secret,
           expires_at = excluded.expires_at, attributes = excluded.attributes, status = 'active', status_detail = null`,
    [clientId, source, conn.tokenKind, (access_token as string) || creds.secret, creds.refresh_secret ?? null,
     access_token ? new Date(Date.now() + Number(expires_in) * 1000) : null, creds.attributes ?? {}])
  await db.query(
    `insert into data.connector_schedule (client_id, source, interval, backfill_from, backfill_cursor, config, next_run_at)
         values ($1, $2, $3::interval, ${backfillFrom(conn.defaults.backfillDepth)}, '{}'::jsonb, $4, now())
         on conflict (client_id, source) do update set config = excluded.config`,
    [clientId, source, conn.defaults.interval, { ...creds.config, ...cfg }])
}

if (isMain(import.meta.url)) runMain(main)
