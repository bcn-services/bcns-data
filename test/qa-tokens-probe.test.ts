// QA (item A4, criterion 1, second half): worker/src/tokens.ts's §5.4 auth_failed probe must also
// go through shopifyEndpoint, so a client stored with a bare `shop` handle (no `.myshopify.com`,
// no scheme) still probes the real Admin API host instead of `https://<handle>/admin/...`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { localKeys, pool, sql, SUPABASE_URL } from './helpers.js'
import { closePool, type Tick } from '../worker/src/db.js'
import { probeAuthFailed } from '../worker/src/tokens.js'

beforeAll(() => {
  process.env.SUPABASE_URL = SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = localKeys().service
})

const made: string[] = []

async function mkAuthFailedShopifyClient(shop: string): Promise<string> {
  const id = randomUUID()
  made.push(id)
  await sql(`insert into data.clients (id, slug, name, timezone) values ($1, $2, 'Tokens Probe Fixture', 'UTC')`,
    [id, `tp-${id.slice(0, 8)}`])
  await sql(`insert into data.connector_schedule (client_id, source, interval, backfill_from, config, next_run_at)
             values ($1, 'shopify', '1 hour', current_date - 7, $2::jsonb, now() + interval '1 day')`,
    [id, JSON.stringify({ shop })])
  await sql(`insert into data.source_tokens (client_id, source, kind, secret, status, updated_at)
             values ($1, 'shopify', 'shopify_admin', 'tkn', 'auth_failed', now() - interval '2 hours')`, [id])
  return id
}

afterAll(async () => {
  if (made.length) {
    for (const t of ['data.connector_schedule', 'data.source_tokens']) await sql(`delete from ${t} where client_id = any($1::uuid[])`, [made])
    await sql(`delete from data.clients where id = any($1::uuid[])`, [made])
  }
  await Promise.all([pool.end(), closePool()])
})

function mkTick(fetch: typeof globalThis.fetch): Tick {
  return {
    taskIndex: 0, taskCount: 1, owner: `test-${randomUUID().slice(0, 8)}`, fetch, stubbed: true,
    now: () => new Date(), log: () => {}, budgetMs: 60_000, claimLimit: 50,
  }
}

describe('tokens.ts §5.4 probe uses the shared shopifyEndpoint', () => {
  it('probes the normalized host for a bare shop handle and clears auth_failed on success', async () => {
    const c = await mkAuthFailedShopifyClient('bare-handle-zz')
    let seenUrl = ''
    const fetch = (async (url: unknown) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({ data: { shop: { id: 1 } } }), { status: 200 })
    }) as typeof globalThis.fetch

    const ok = await probeAuthFailed(mkTick(fetch))

    expect(seenUrl).toBe('https://bare-handle-zz.myshopify.com/admin/api/2026-07/graphql.json')
    expect(ok).toBe(1)
    const row = (await sql<{ status: string }>(`select status from data.source_tokens where client_id = $1`, [c])).rows[0]
    expect(row.status).toBe('active')
  })

  it('mutation guard: a broken shopHandle would probe a host with the scheme still embedded', async () => {
    const c = await mkAuthFailedShopifyClient('https://another-zz.myshopify.com/')
    let seenUrl = ''
    const fetch = (async (url: unknown) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({ data: { shop: { id: 1 } } }), { status: 200 })
    }) as typeof globalThis.fetch

    await probeAuthFailed(mkTick(fetch))
    // A regression to `https://${shop}/admin/...` would leave the scheme doubled/embedded in the host.
    expect(seenUrl).toBe('https://another-zz.myshopify.com/admin/api/2026-07/graphql.json')
    expect(seenUrl).not.toContain('https://https://')
    void c
  })
})
