// Shared test helpers: local stack keys, seeded ids, DB pool, per-user PostgREST/Storage clients.
import { execSync } from 'node:child_process'
import pg from 'pg'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
export type Api = SupabaseClient<any, 'api', any>
import { SignJWT } from 'jose'

export const DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
export const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'

let keys: { anon: string; service: string; jwtSecret: string } | undefined
export function localKeys() {
  if (!keys) {
    const s = JSON.parse(execSync('supabase status -o json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
    keys = { anon: s.ANON_KEY, service: s.SERVICE_ROLE_KEY, jwtSecret: s.JWT_SECRET }
  }
  return keys
}

export const pool = new pg.Pool({ connectionString: DB_URL, max: 4 })
export const sql = <T extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => pool.query<T>(text, params)

export const CLIENTS = {
  acme: 'a0000000-0000-4000-8000-000000000001',
  beta: 'b0000000-0000-4000-8000-000000000001',
  gamma: 'c0000000-0000-4000-8000-000000000001',
} as const

export const USERS = {
  acmeMember: { id: 'a0000000-0000-4000-8000-0000000000a1', email: 'acme-member@example.com', password: 'password-acme', client: CLIENTS.acme },
  acmeOwner: { id: 'a0000000-0000-4000-8000-0000000000a2', email: 'acme-owner@example.com', password: 'password-acme', client: CLIENTS.acme },
  acmeSmoke: { id: 'a0000000-0000-4000-8000-0000000000a3', email: 'acme-smoke@example.com', password: 'password-acme', client: CLIENTS.acme },
  betaMember: { id: 'b0000000-0000-4000-8000-0000000000b1', email: 'beta-member@example.com', password: 'password-beta', client: CLIENTS.beta },
  betaSmoke: { id: 'b0000000-0000-4000-8000-0000000000b3', email: 'beta-smoke@example.com', password: 'password-beta', client: CLIENTS.beta },
  gammaMember: { id: 'c0000000-0000-4000-8000-0000000000c1', email: 'gamma-member@example.com', password: 'password-gamma', client: CLIENTS.gamma },
  nobody: { id: 'd0000000-0000-4000-8000-0000000000d1', email: 'nobody@example.com', password: 'password-nobody', client: null },
} as const
export type SeedUser = (typeof USERS)[keyof typeof USERS]

/** Seeded media ids: acme = aaaaaaaa-…-000000000001..3, beta = bbbbbbbb-…, gamma = cccccccc-… */
export const mediaId = (client: keyof typeof CLIENTS, n: 1 | 2 | 3) =>
  `${CLIENTS[client][0].repeat(8)}-0000-4000-8000-00000000000${n}`
export const origPath = (client: keyof typeof CLIENTS, n: 1 | 2 | 3) => `${CLIENTS[client]}/orig/${mediaId(client, n)}.png`
export const thumbPath = (client: keyof typeof CLIENTS, n: 1 | 2 | 3) => `${CLIENTS[client]}/thumb/${mediaId(client, n)}.jpg`

const opts = { db: { schema: 'api' as const }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export function anonClient(): Api {
  return createClient(SUPABASE_URL, localKeys().anon, opts)
}
export function serviceClient(): Api {
  return createClient(SUPABASE_URL, localKeys().service, opts)
}
export function clientWithToken(token: string): Api {
  return createClient(SUPABASE_URL, localKeys().anon, { ...opts, global: { headers: { Authorization: `Bearer ${token}` } } })
}

/** Sign in through GoTrue (exercises the custom access token hook). */
export async function signIn(user: SeedUser): Promise<{ client: Api; token: string; claims: Record<string, any> }> {
  const c = anonClient()
  const { data, error } = await c.auth.signInWithPassword({ email: user.email, password: user.password })
  if (error || !data.session) throw new Error(`signIn ${user.email}: ${error?.message}`)
  const token = data.session.access_token
  return { client: clientWithToken(token), token, claims: decodeJwt(token) }
}

export function decodeJwt(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
}

/** Service-minted authenticated JWT (no hook). Pass claims to add e.g. client_id. */
export async function mintJwt(sub: string, claims: Record<string, unknown> = {}, ttlSec = 600): Promise<string> {
  return new SignJWT({ role: 'authenticated', aud: 'authenticated', sub, ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec)
    .sign(new TextEncoder().encode(localKeys().jwtSecret))
}

/** Raw PostgREST GET; returns status + parsed body. */
export async function rest(path: string, token?: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: localKeys().anon, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  })
  const text = await r.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, body }
}

/** Every api view name, from the catalog. */
export async function apiViews(): Promise<string[]> {
  const r = await sql<{ viewname: string }>(`select viewname from pg_views where schemaname = 'api' order by 1`)
  return r.rows.map(x => x.viewname)
}

/** 1x1 PNG bytes for upload tests. */
export const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/**
 * One argument builder per api RPC, every id pointing at seeded `beta` rows. Used by the
 * cross-tenant and no-claim tests; a new RPC without an entry fails `rpc_every_write_scoped`.
 * `expect`: 'BCNS3'/'BCNS4' — single-id RPC must raise that code; 'ignored' — array RPC must return 0 / touch nothing;
 * 'none' — RPC has no id argument, beta rows must simply stay unchanged.
 */
export const RPC_ARGS: Record<string, { args: Record<string, unknown>; expect: 'BCNS3' | 'BCNS4' | 'ignored' | 'none' }> = {
  save_record: { args: { kind: 'note', attributes: {}, external_id: 'rec-0', title: 'x' }, expect: 'none' },
  delete_record: { args: { record_id: null }, expect: 'BCNS4' }, // record_id filled at runtime
  register_upload: { args: { path: origPath('beta', 1) }, expect: 'BCNS3' }, // foreign prefix fails path validation before lookup
  update_media: { args: { media_id: mediaId('beta', 1), title: 'x' }, expect: 'BCNS4' },
  bulk_tag: { args: { media_ids: [mediaId('beta', 1), mediaId('beta', 2)], add: ['x'] }, expect: 'ignored' },
  delete_media: { args: { media_ids: [mediaId('beta', 1), mediaId('beta', 2)] }, expect: 'ignored' },
  restore_media: { args: { media_ids: [mediaId('beta', 1), mediaId('beta', 2)] }, expect: 'ignored' },
  create_media_set: { args: { name: 'rpc-scoped-test' }, expect: 'none' },
  update_media_set: { args: { set_id: null, name: 'x' }, expect: 'BCNS4' }, // set_id filled at runtime
  delete_media_set: { args: { set_id: null }, expect: 'BCNS4' },
  set_media_set_items: { args: { set_id: null, media_ids: [mediaId('beta', 1)], action: 'remove' }, expect: 'BCNS4' },
  reorder_media_set_items: { args: { set_id: null, media_ids: [mediaId('beta', 1)] }, expect: 'BCNS4' },
  download_url: { args: { media_id: mediaId('beta', 1) }, expect: 'BCNS4' },
  report_dashboard_version: { args: { app_version: '0', api_version: 'v1' }, expect: 'none' },
  remove_member: { args: { target_user_id: USERS.betaMember.id }, expect: 'BCNS4' },
}

/** Fill the runtime-only beta ids (record, media set) into RPC_ARGS. */
export async function betaRpcArgs() {
  const rec = await sql(`select id from data.records where client_id = $1 and source = 'dashboard' limit 1`, [CLIENTS.beta])
  const set = await sql(`select id from data.media_sets where client_id = $1 order by name limit 1`, [CLIENTS.beta])
  const out = structuredClone(RPC_ARGS)
  out.delete_record.args.record_id = rec.rows[0].id
  for (const k of ['update_media_set', 'delete_media_set', 'set_media_set_items', 'reorder_media_set_items']) out[k].args.set_id = set.rows[0].id
  return out
}

/** Snapshot of beta's mutable rows for "unchanged" assertions. */
export async function betaSnapshot() {
  const r = await sql(`select
    (select count(*)||'/'||coalesce(max(updated_at)::text,'') from data.records where client_id = $1) records,
    (select count(*)||'/'||coalesce(max(updated_at)::text,'') from data.media where client_id = $1) media,
    (select count(*)||'/'||coalesce(max(updated_at)::text,'') from data.media_sets where client_id = $1) media_sets,
    (select count(*) from data.media_set_items where client_id = $1) media_set_items,
    (select count(*) from data.memberships where client_id = $1) memberships,
    (select count(*) from data.dashboard_versions where client_id = $1) dashboard_versions,
    (select count(*)||'/'||coalesce(sum(bytes),0) from data.egress_ledger where client_id = $1) egress,
    (select count(*) from data.download_tickets where client_id = $1) tickets`, [CLIENTS.beta])
  return r.rows[0]
}
