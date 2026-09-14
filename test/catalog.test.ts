import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { sql, pool, rest, signIn, mintJwt, apiViews, betaRpcArgs, USERS, CLIENTS } from './helpers.js'

const T = '( SELECT data.active_client_id() AS active_client_id)'
// Allowed policy quals per table (§2.4). Anything not listed must be exactly `client_id = T`.
const QUAL_ALLOW: Record<string, string> = {
  clients: `(id = ${T})`,
  records: `((client_id = ${T}) AND (deleted_at IS NULL))`,
}
const HELPERS = ['data.active_client_id', 'data.active_client_role', 'data.egress_exceeded', 'data.has_download_ticket']
const INTERNAL = ['raw', 'raw_latest', 'connector_schedule', 'connector_runs', 'notifications', 'source_tokens', 'worker_leases', 'download_tickets', 'metric_defs']
// Supabase's own roles carry BYPASSRLS/SUPERUSER on every stack; nothing we create may.
const PLATFORM_ROLES = ['postgres', 'supabase_admin', 'service_role', 'supabase_read_only_user', 'supabase_etl_admin'] // etl_admin: PG17 image (Supabase ETL replication)

afterAll(() => pool.end())

describe('catalog', () => {
  it('rls_every_table', async () => {
    const tables = await sql<{ relname: string; rls: boolean; force: boolean }>(
      `select c.relname, c.relrowsecurity rls, c.relforcerowsecurity force from pg_class c
         join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'data' and c.relkind in ('r','p')`)
    expect(tables.rows.length).toBeGreaterThan(20)
    for (const t of tables.rows) expect({ t: t.relname, rls: t.rls, force: t.force }).toEqual({ t: t.relname, rls: true, force: true })

    const granted = new Set((await sql<{ table_name: string }>(
      `select distinct table_name from information_schema.role_table_grants where table_schema = 'data' and grantee = 'authenticated'`)).rows.map(r => r.table_name))
    const pols = await sql<{ relname: string; polname: string; roles: string[]; qual: string | null; cmd: string }>(
      `select c.relname, p.polname, p.polroles::regrole[]::text[] roles, pg_get_expr(p.polqual, p.polrelid) qual, p.polcmd cmd
         from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'data'`)
    const authPols = pols.rows.filter(p => p.roles.includes('authenticated') || p.roles.includes('-'))
    for (const p of authPols) {
      expect(granted.has(p.relname), `policy on ungranted table ${p.relname}`).toBe(true)
      expect(p.qual, `${p.relname}.${p.polname}`).toBe(QUAL_ALLOW[p.relname] ?? `(client_id = ${T})`)
    }
    for (const t of granted) expect(authPols.some(p => p.relname === t), `${t} granted but no policy`).toBe(true)
  })

  it('owner_bypassrls', async () => {
    const rels = await sql<{ n: string }>(`select n.nspname||'.'||c.relname n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_roles r on r.oid = c.relowner where n.nspname in ('data','api') and r.rolname <> 'postgres'`)
    expect(rels.rows).toEqual([])
    const fns = await sql<{ n: string }>(`select p.proname n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.oid = p.proowner where n.nspname in ('data','api') and r.rolname <> 'postgres'`)
    expect(fns.rows).toEqual([])
    const roles = await sql<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolname, rolbypassrls, rolsuper from pg_roles where rolbypassrls or rolsuper`)
    expect(roles.rows.find(r => r.rolname === 'postgres')?.rolbypassrls).toBe(true)
    expect(roles.rows.map(r => r.rolname).filter(r => !PLATFORM_ROLES.includes(r))).toEqual([])
  })

  it('function_privileges', async () => {
    const fns = await sql<{ name: string; schema: string; auth: boolean; anon: boolean }>(
      `select n.nspname schema, n.nspname||'.'||p.proname name, has_function_privilege('authenticated', p.oid, 'execute') auth,
              has_function_privilege('anon', p.oid, 'execute') anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('data','api')`)
    for (const f of fns.rows) {
      expect(f.anon, `${f.name} executable by anon`).toBe(false)
      expect(f.auth, `${f.name} authenticated`).toBe(f.schema === 'api' || HELPERS.includes(f.name))
    }
  })

  // Mirrors hosted advisor lint 0011 function_search_path_mutable: every function in data/api
  // must pin search_path, so a new one added without the clause fails here and not in production.
  it('function_search_path_pinned', async () => {
    const fns = await sql<{ name: string; pinned: boolean }>(
      `select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' name,
              exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search\\_path=%') pinned
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('data','api','public') order by 1`)
    expect(fns.rows.length).toBeGreaterThan(29)
    expect(fns.rows.filter(f => !f.pinned).map(f => f.name)).toEqual([])
  })

  // dt-review: the create branch of ensure_raw_partitions only runs when a month is missing, which
  // never happens in CI (the schema migration seeds months 0..2). Drop the empty +2 partition and
  // prove the dynamic SQL still creates, RLS-enables and un-grants it under the pinned search_path.
  it('ensure_raw_partitions_creates_under_pinned_path', async () => {
    const name = (await sql<{ p: string }>(
      `select 'raw_' || to_char(date_trunc('month', now()) + interval '2 months', 'YYYY_MM') p`)).rows[0].p
    await sql(`drop table data.${name}`)
    await sql(`select data.ensure_raw_partitions()`)
    const r = await sql<{ rls: boolean; force: boolean; anon: boolean; authed: boolean }>(
      `select c.relrowsecurity rls, c.relforcerowsecurity force,
              has_table_privilege('anon', c.oid, 'select') anon, has_table_privilege('authenticated', c.oid, 'select') authed
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'data' and c.relname = $1`, [name])
    expect(r.rows).toEqual([{ rls: true, force: true, anon: false, authed: false }])
  })

  it('hook_mints_claims', async () => {
    const call = async (uid: string) => (await sql<{ out: any }>(
      `select public.custom_access_token_hook(jsonb_build_object('user_id', $1::text, 'claims', '{"role":"authenticated"}'::jsonb)) out`, [uid])).rows[0].out
    const ok = await call(USERS.acmeMember.id)
    expect(ok.claims).toMatchObject({ client_id: CLIENTS.acme, client_role: 'member', role: 'authenticated' })
    expect((await call(USERS.gammaMember.id)).error).toMatchObject({ http_code: 403 })
    expect((await call(USERS.nobody.id)).error).toMatchObject({ http_code: 403 })
    const live = await signIn(USERS.acmeOwner)
    expect(live.claims).toMatchObject({ client_id: CLIENTS.acme, client_role: 'owner' })
    await expect(signIn(USERS.gammaMember)).rejects.toThrow()
  })

  it('api_views_security_invoker', async () => {
    const r = await sql<{ relname: string; reloptions: string[] | null }>(
      `select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'api' and c.relkind = 'v'`)
    expect(r.rows.length).toBeGreaterThan(10)
    for (const v of r.rows) expect(v.reloptions ?? [], v.relname).toContain('security_invoker=true')
  })

  it('api_views_common_columns', async () => {
    const r = await sql<{ table_name: string; cols: string[] }>(
      `select table_name, array_agg(column_name::text) cols from information_schema.columns where table_schema = 'api' group by 1`)
    for (const v of r.rows) expect(v.cols, v.table_name).toEqual(expect.arrayContaining(['client_id', 'source', 'updated_at']))
  })

  it('api_columns_additive', async () => {
    const snap: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL('../api/contract.json', import.meta.url), 'utf8'))
    const live = await sql<{ table_name: string; column_name: string; type: string }>(
      `select table_name, column_name, case when data_type in ('USER-DEFINED','ARRAY') then udt_name else data_type end as type
         from information_schema.columns where table_schema = 'api'`)
    const liveMap: Record<string, Record<string, string>> = {}
    for (const r of live.rows) (liveMap[r.table_name] ??= {})[r.column_name] = r.type
    for (const [view, cols] of Object.entries(snap))
      for (const [col, type] of Object.entries(cols)) expect(liveMap[view]?.[col], `${view}.${col}`).toBe(type)
  })

  it('exposed_schemas_api_only', async () => {
    const toml = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8')
    expect(toml).toMatch(/^schemas = \["api"\]/m)
    const { client, token } = await signIn(USERS.acmeMember)
    void client
    const { status, body } = await rest('', token)
    expect(status).toBe(200)
    const views = await apiViews()
    const paths = Object.keys(body.paths ?? {}).filter(p => p !== '/')
    expect(paths.length).toBeGreaterThan(10)
    for (const p of paths) {
      expect(p, p).not.toMatch(/data\./)
      const name = p.replace(/^\/(rpc\/)?/, '')
      if (!p.startsWith('/rpc/')) expect(views, p).toContain(name)
    }
    for (const t of INTERNAL) expect(paths).not.toContain(`/${t}`)
  })

  it('internal_tables_unreachable', async () => {
    const { token } = await signIn(USERS.acmeMember)
    for (const t of INTERNAL) {
      expect((await rest(`${t}?limit=1`, token)).status, t).toBe(404)
      const priv = await sql<{ ok: boolean }>(`select has_table_privilege('authenticated', $1, 'select') ok`, [`data.${t}`])
      expect(priv.rows[0].ok, t).toBe(false)
    }
  })

  it('tokens_unreachable', async () => {
    const { token } = await signIn(USERS.acmeMember)
    expect((await rest('source_tokens', token)).status).toBe(404)
    const deps = await sql(`select distinct dependent.relname from pg_depend d
      join pg_rewrite r on r.oid = d.objid join pg_class dependent on dependent.oid = r.ev_class
      join pg_class ref on ref.oid = d.refobjid join pg_namespace n on n.oid = ref.relnamespace
      where n.nspname = 'data' and ref.relname = 'source_tokens' and dependent.relnamespace = 'api'::regnamespace`)
    expect(deps.rows).toEqual([])
    const bodies = await sql(`select proname from pg_proc where pronamespace = 'api'::regnamespace and prosrc ilike '%source_tokens%'`)
    expect(bodies.rows).toEqual([])
  })

  it('rpc_sets_client_from_claim', async () => {
    const { client } = await signIn(USERS.acmeMember)
    const ext = `claimtest-${Date.now()}`
    const { data: id, error } = await client.rpc('save_record', { kind: 'note', attributes: { client_id: CLIENTS.beta }, external_id: ext })
    expect(error).toBeNull()
    const row = await sql(`select client_id from data.records where id = $1`, [id])
    expect(row.rows[0].client_id).toBe(CLIENTS.acme)
    await sql(`delete from data.records where id = $1`, [id])
    const args = await sql<{ proname: string; a: string[] | null }>(`select proname, proargnames a from pg_proc where pronamespace = 'api'::regnamespace`)
    for (const f of args.rows) expect(f.a ?? [], f.proname).not.toContain('client_id')
  })

  it('no_claim_zero_rows', async () => {
    const token = await mintJwt(USERS.nobody.id)
    for (const v of await apiViews()) {
      const { status, body } = await rest(`${v}?limit=5`, token)
      expect(status, v).toBe(200)
      expect(body, v).toEqual([])
    }
    const rpcs = await sql<{ proname: string }>(`select proname from pg_proc where pronamespace = 'api'::regnamespace`)
    const argsFor = await betaRpcArgs()
    for (const f of rpcs.rows) {
      expect(argsFor[f.proname], `no RPC_ARGS entry for ${f.proname}`).toBeDefined()
      const { status, body } = await rest(`rpc/${f.proname}`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(argsFor[f.proname].args) })
      expect(status, f.proname).toBeGreaterThanOrEqual(400)
      expect(body.code, f.proname).toBe('BCNS0')
    }
  })
})
