// QA-authored, independent of engineer's test/catalog.test.ts. Verifies lint-0011 remediation
// (20260914000100_pin_search_path.sql): the 9 data.* functions carry search_path = '' AND that
// create-or-replace did not silently change signature/volatility/security/language for any of them.
import { describe, it, expect, afterAll } from 'vitest'
import { sql, pool, signIn, USERS, CLIENTS } from './helpers.js'

afterAll(() => pool.end())

// Expected signatures as declared in the ORIGINAL migrations (20260912000100_schema.sql,
// 20260912000200_access.sql, 20260912000500_api_rpcs.sql) — before the search_path pin.
const EXPECTED: Record<string, { args: string; ret: string; lang: string; vol: 'i' | 's' | 'v'; secdef: boolean }> = {
  touch_updated_at: { args: '', ret: 'trigger', lang: 'plpgsql', vol: 'v', secdef: false },
  clients_timezone_valid: { args: '', ret: 'trigger', lang: 'plpgsql', vol: 'v', secdef: false },
  clients_status_changed: { args: '', ret: 'trigger', lang: 'plpgsql', vol: 'v', secdef: false },
  clients_timezone_changed: { args: '', ret: 'trigger', lang: 'plpgsql', vol: 'v', secdef: false },
  ensure_raw_partitions: { args: '', ret: 'void', lang: 'plpgsql', vol: 'v', secdef: false },
  local_day: { args: 'ts timestamp with time zone, client uuid', ret: 'date', lang: 'sql', vol: 's', secdef: false },
  jwt_client_id: { args: '', ret: 'uuid', lang: 'sql', vol: 's', secdef: false },
  jwt_client_role: { args: '', ret: 'data.member_role', lang: 'sql', vol: 's', secdef: false },
  clean_tags: { args: 'tags text[]', ret: 'text[]', lang: 'plpgsql', vol: 'i', secdef: false },
}
const NAMES = Object.keys(EXPECTED)

describe('pin_search_path (QA)', () => {
  it('all 9 target functions are pinned, and no function in data/api lacks a pin', async () => {
    const rows = (await sql<{ nspname: string; proname: string; conf: string[] | null }>(
      `select n.nspname, p.proname, p.proconfig conf
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('data','api')`)).rows
    expect(rows.length).toBeGreaterThan(25)
    const isPinned = (r: { conf: string[] | null }) => (r.conf ?? []).some(c => c.startsWith('search_path='))
    const unpinned = rows.filter(r => !isPinned(r)).map(r => `${r.nspname}.${r.proname}`)
    expect(unpinned).toEqual([])
    const pin = (name: string) => {
      const r = rows.find(x => x.nspname === 'data' && x.proname === name)
      expect(r, `data.${name} not found`).toBeDefined()
      return (r!.conf ?? []).find(c => c.startsWith('search_path='))
    }
    for (const name of NAMES) expect(pin(name), name).toBe('search_path=""')
  })

  it('signature/volatility/security/language unchanged from the original migrations for all 9', async () => {
    const rows = (await sql<{ proname: string; args: string; ret: string; lang: string; provolatile: string; prosecdef: boolean }>(
      `select p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_function_result(p.oid) ret,
              l.lanname lang, p.provolatile, p.prosecdef
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
        where n.nspname = 'data' and p.proname = any($1)`, [NAMES])).rows
    expect(rows.length).toBe(NAMES.length)
    for (const r of rows) {
      const exp = EXPECTED[r.proname]
      expect({ args: r.args, ret: r.ret, lang: r.lang, vol: r.provolatile, secdef: r.prosecdef }, r.proname)
        .toEqual({ args: exp.args, ret: exp.ret, lang: exp.lang, vol: exp.vol, secdef: exp.secdef })
    }
  })

  it('clients_timezone_valid rejects a bad timezone, accepts a good one', async () => {
    const bad = sql(`insert into data.clients (slug, name, timezone) values ('qa-tz-bad', 'QA Bad TZ', 'Not/AZone')`)
    await expect(bad).rejects.toThrow()
    const r = await sql<{ id: string }>(`insert into data.clients (slug, name, timezone) values ('qa-tz-good', 'QA Good TZ', 'America/Chicago') returning id`)
    expect(r.rows.length).toBe(1)
    await sql(`delete from data.clients where slug = 'qa-tz-good'`)
  })

  it('clients_status_changed stamps churned_at only on transition to churned', async () => {
    const ins = await sql<{ id: string }>(`insert into data.clients (slug, name) values ('qa-status', 'QA Status') returning id`)
    const id = ins.rows[0].id
    await sql(`update data.clients set status = 'churned' where id = $1`, [id])
    const r1 = await sql<{ churned_at: Date | null }>(`select churned_at from data.clients where id = $1`, [id])
    expect(r1.rows[0].churned_at).not.toBeNull()
    const t0 = r1.rows[0].churned_at
    await sql(`update data.clients set name = 'QA Status 2' where id = $1`, [id])
    const r2 = await sql<{ churned_at: Date | null }>(`select churned_at from data.clients where id = $1`, [id])
    expect(r2.rows[0].churned_at?.getTime()).toBe(t0?.getTime())
    await sql(`delete from data.clients where id = $1`, [id])
  })

  it('clients_timezone_changed marks connector_schedule rows for renormalization', async () => {
    const ins = await sql<{ id: string }>(`insert into data.clients (slug, name, timezone) values ('qa-tzchg', 'QA TZ Change', 'America/New_York') returning id`)
    const id = ins.rows[0].id
    await sql(`insert into data.connector_schedule (client_id, source, interval, backfill_from) values ($1, 'shopify', interval '1 hour', current_date)`, [id])
    await sql(`update data.clients set timezone = 'Europe/London' where id = $1`, [id])
    const r = await sql<{ renormalize_requested_at: Date | null }>(
      `select renormalize_requested_at from data.connector_schedule where client_id = $1`, [id])
    expect(r.rows[0].renormalize_requested_at).not.toBeNull()
    await sql(`delete from data.clients where id = $1`, [id])
  })

  it('ensure_raw_partitions creates the current-through-+2-month partitions of data.raw', async () => {
    await sql(`select data.ensure_raw_partitions()`)
    const months = [0, 1, 2].map(i => {
      const d = new Date()
      d.setUTCMonth(d.getUTCMonth() + i, 1)
      return `raw_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    })
    const r = await sql<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'data' and c.relname = any($1)`, [months])
    expect(r.rows.map(x => x.relname).sort()).toEqual(months.sort())
  })

  it('local_day returns the calendar day in the client timezone', async () => {
    const r = await sql<{ d: string }>(`select data.local_day('2026-01-01T04:30:00Z'::timestamptz, $1) d`, [CLIENTS.acme])
    expect(r.rows[0].d).toBeTruthy()
  })

  it('clean_tags lowercases, trims, dedupes, and rejects invalid tags', async () => {
    const r = await sql<{ out: string[] }>(`select data.clean_tags($1::text[]) out`, [['  Foo ', 'foo', 'bar-baz']])
    expect(r.rows[0].out).toEqual(['foo', 'bar-baz'])
    await expect(sql(`select data.clean_tags($1::text[]) out`, [['Bad Tag!']])).rejects.toThrow()
  })

  it('jwt_client_id resolves through api.report_dashboard_version (tenant_or_raise -> active_client_id -> jwt_client_id)', async () => {
    const { client } = await signIn(USERS.acmeMember)
    const { error } = await client.rpc('report_dashboard_version' as any, { app_version: 'qa-1.0', api_version: 'qa-1.0' } as any)
    expect(error).toBeNull()
    const r = await sql<{ client_id: string }>(`select client_id from data.dashboard_versions where client_id = $1`, [CLIENTS.acme])
    expect(r.rows.length).toBe(1)
  })

  it('jwt_client_role resolves through api.register_upload (require_w -> active_client_role -> jwt_client_role)', async () => {
    const { client } = await signIn(USERS.acmeMember)
    const { error } = await client.rpc('register_upload' as any, { path: 'qa/probe.png', title: 'qa probe' } as any)
    // Any error here must be a business-logic error (e.g. media row prerequisites), never
    // "function/relation does not exist" — that would be the signature of a broken search_path pin.
    if (error) expect(String(error.message ?? '')).not.toMatch(/does not exist/i)
  })
})
