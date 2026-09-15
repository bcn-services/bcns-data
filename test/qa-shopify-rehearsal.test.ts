// Dev-store rehearsal findings (2026-09-14): OAuth installs return `shpua_` tokens, and protected customer
// data Level 2 gates both the order customer fields (checklist S6) and ShopifyQL (checklist S4).
import { describe, expect, it } from 'vitest'
import { redact } from '../worker/src/connectors/index.js' // connectors registry first; see qa-checklist-s1.test.ts
import { checklist } from '../scripts/checklist.js'

const ALL_SCOPES = ['read_orders', 'read_all_orders', 'read_products', 'read_inventory', 'read_shopify_payments_payouts', 'read_reports', 'read_customers']
const SCOPES = { data: { currentAppInstallation: { accessScopes: ALL_SCOPES.map((handle) => ({ handle })) }, shop: { ianaTimezone: 'UTC', currencyCode: 'USD' } } }
const DENIED = { errors: [{ message: 'Access denied for field.', extensions: { code: 'ACCESS_DENIED' } }] }

// Routes by query text: ShopifyQL probe (S4), order-customer probe (S6), else the scope query.
const shop = (o: { s4?: unknown; s6?: unknown } = {}) => (async (_u: unknown, init?: RequestInit) => {
  const q = String(init?.body)
  const body = q.includes('shopifyqlQuery') ? o.s4 ?? { data: { shopifyqlQuery: { __typename: 'TableResponse' } } }
    : q.includes('orders(') ? o.s6 ?? { data: { orders: { nodes: [] } } }
    : SCOPES
  return new Response(JSON.stringify(body))
}) as unknown as typeof globalThis.fetch
const run = (f: typeof globalThis.fetch) => checklist('shopify', 'UTC', { secret: 'shpua_x', config: { shop: 'zz' } }, f)

describe('redact', () => {
  it('masks OAuth shpua_ and custom-app shpat_ tokens', () => {
    const out = redact('bad token shpua_0123456789abcdef and shpat_fedcba9876543210')
    expect(out).not.toMatch(/0123456789abcdef|fedcba9876543210/)
    expect(out).toBe('bad token shpua_*** and shpat_***')
  })
  it('leaves non-token text alone', () => expect(redact('HTTP 503 shop unavailable')).toBe('HTTP 503 shop unavailable'))
})

describe('checklist protected customer data Level 2', () => {
  it('passes with sessions_mode shopifyql when both probes succeed', async () => {
    const v = await run(shop())
    expect(v.config.sessions_mode).toBe('shopifyql')
    expect(v.warnings.filter((w) => w.startsWith('S4'))).toEqual([])
  })
  it('S6 refuses when order customer fields are denied', async () => {
    await expect(run(shop({ s6: DENIED }))).rejects.toThrow(/^S6: .*Level 2/)
  })
  it('S6 refuses on any other orders error, since the worker would fail the same way', async () => {
    await expect(run(shop({ s6: { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] } }))).rejects.toThrow('S6: orders query failed: THROTTLED')
  })
  it('S4 warns and sets none when ShopifyQL is denied', async () => {
    const v = await run(shop({ s4: DENIED }))
    expect(v.config.sessions_mode).toBe('none')
    expect(v.warnings).toContainEqual(expect.stringMatching(/^S4: .*Level 2/))
  })
  it('S4 sets none without a warning when the dataset itself is unavailable', async () => {
    const v = await run(shop({ s4: { errors: [{ message: "Table 'sessions' not found" }] } }))
    expect(v.config.sessions_mode).toBe('none')
    expect(v.warnings.filter((w) => w.startsWith('S4'))).toEqual([])
  })
})
