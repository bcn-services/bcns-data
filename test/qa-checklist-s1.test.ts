// QA (item A4, criterion 3): checklist S1 must no longer require the `shpat_` prefix -- a
// prefix-less token reaches the GraphQL scope query, and a token missing scopes still fails
// S1/S2 by the scope result alone. Independent of engineer's own scripts.test.ts coverage.
import { describe, expect, it } from 'vitest'
// NB: see the "shopify.js entry-point crash" finding in qa-report.md -- checklist.ts now pulls
// worker/src/connectors/shopify.js at runtime, and that module crashes at import time if it (or
// checklist.js) is the first module to touch the connectors registry in a cold module graph.
// Every real caller (onboard.ts, add-source.ts) imports connectors/index.js first, so mirror
// that here to isolate this file's coverage from the separate, already-reported fragility.
import '../worker/src/connectors/index.js'
import { checklist } from '../scripts/checklist.js'

const scopesResponse = (scopes: string[]) => ({
  data: {
    currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
    shop: { ianaTimezone: 'UTC', currencyCode: 'USD' },
  },
})
const ALL_SCOPES = ['read_orders', 'read_all_orders', 'read_products', 'read_inventory', 'read_shopify_payments_payouts', 'read_reports', 'read_customers']
const json = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 })

describe('checklist S1/S2 without the shpat_ prefix', () => {
  it('a token with no shpat_ prefix reaches the scope query and passes when every scope is present', async () => {
    let reachedScopeQuery = false
    let sentToken: string | undefined
    const fetch = (async (url: unknown, init?: RequestInit) => {
      reachedScopeQuery = true
      sentToken = (init?.headers as Record<string, string>)?.['X-Shopify-Access-Token']
      return new Response(JSON.stringify(scopesResponse(ALL_SCOPES)))
    }) as unknown as typeof globalThis.fetch

    const v = await checklist('shopify', 'UTC', { secret: 'no-prefix-token', config: { shop: 'zz' } }, fetch)

    expect(reachedScopeQuery).toBe(true)
    expect(sentToken).toBe('no-prefix-token')
    expect(v.config).toMatchObject({ store_timezone: 'UTC', currency: 'USD' })
  })

  it('a prefix-less token missing a non-read_all_orders scope fails S1 (not S2) by the scope result', async () => {
    const missingOne = ALL_SCOPES.filter((s) => s !== 'read_products')
    const fetch = json(scopesResponse(missingOne)) as unknown as typeof globalThis.fetch
    await expect(checklist('shopify', 'UTC', { secret: 'no-prefix-token', config: { shop: 'zz' } }, fetch))
      .rejects.toThrow(/^S1: missing scopes read_products$/)
  })

  it('a prefix-less token missing read_all_orders fails S2, still decided purely by scopes', async () => {
    const missingAllOrders = ALL_SCOPES.filter((s) => s !== 'read_all_orders')
    const fetch = json(scopesResponse(missingAllOrders)) as unknown as typeof globalThis.fetch
    await expect(checklist('shopify', 'UTC', { secret: 'no-prefix-token', config: { shop: 'zz' } }, fetch))
      .rejects.toThrow(/^S2: missing scopes read_all_orders$/)
  })

  it('mutation guard: reinstating the shpat_ prefix throw must reject this same prefix-less token before it reaches the scope query', async () => {
    // Documents the exact assertion the (c) mutation check exercises against the real source
    // (see qa-report.md Mutation Checks): with the old throw restored, this call rejects with
    // an "shpat_" message instead of resolving, and the scope-query fetch above is never reached.
    const fetch = json(scopesResponse(ALL_SCOPES)) as unknown as typeof globalThis.fetch
    await expect(checklist('shopify', 'UTC', { secret: 'no-prefix-token', config: { shop: 'zz' } }, fetch))
      .resolves.toBeDefined()
  })
})
