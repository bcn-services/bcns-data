// §4.2 Shopify — Admin GraphQL 2026-07, custom-app token, never expires.
import { z } from 'zod'
import {
  type CanonicalWrites, type Connector, type Json, type MetricRow, type MoneyRow, type Page,
  type ProductRow, type RawRow, type RunContext, type CustomerRow,
  SourceError, localDay, minor, sleep,
} from './index.js'
import { Q_SHOPIFYQL, sessionsQuery, shopHandle, shopifyEndpoint } from './shopify-url.js'

const PAGE_ORDERS = 50
const PAGE_PRODUCTS = 50
const PAGE_PAYOUTS = 100

const configSchema = z.object({
  shop: z.string(),
  admin_url: z.string().optional(),
  currency: z.string().optional(),
  store_timezone: z.string().optional(),
  sessions_mode: z.enum(['shopifyql', 'none']).default('none'),
}).passthrough()

const adminUrl = (ctx: RunContext) =>
  ctx.config.admin_url ?? `https://admin.shopify.com/store/${shopHandle(ctx.config.shop)}`

const numericId = (gid: string) => String(gid).split('/').pop() ?? gid

async function gql(ctx: RunContext, query: string, variables: Json = {}): Promise<Json> {
  const r = await ctx.fetch(shopifyEndpoint(ctx.config.shop), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': ctx.token.secret },
    body: JSON.stringify({ query, variables }),
  })
  const body = await r.json().catch(() => ({}))
  if (body?.errors?.length) throw new SourceError('shopify', String(body.errors[0]?.message ?? 'graphql error'), r.status, body)
  if (!r.ok) throw new SourceError('shopify', `HTTP ${r.status}`, r.status, body)
  // Cost-aware throttle: sleep off the deficit before the next page.
  const ts = body?.extensions?.cost?.throttleStatus
  const cost = Number(body?.extensions?.cost?.requestedQueryCost ?? 0)
  if (ts && Number(ts.currentlyAvailable) < cost) {
    await sleep(Math.max(0, ((cost - Number(ts.currentlyAvailable)) / Number(ts.restoreRate || 50)) * 1000))
  }
  return body.data
}

const ORDER_FIELDS = `id name createdAt updatedAt processedAt cancelledAt displayFinancialStatus
  displayFulfillmentStatus currencyCode totalPriceSet{shopMoney{amount currencyCode}}
  currentTotalPriceSet{shopMoney{amount currencyCode}} customer{id email displayName}
  lineItems(first:25){nodes{id title sku quantity discountedTotalSet{shopMoney{amount}}}}
  refunds(first:10){id createdAt totalRefundedSet{shopMoney{amount currencyCode}}}`

const Q_ORDERS = `query O($after:String,$q:String){orders(first:${PAGE_ORDERS},after:$after,sortKey:UPDATED_AT,query:$q){pageInfo{hasNextPage endCursor}nodes{${ORDER_FIELDS}}}}`
const Q_PRODUCTS = `query P($after:String,$q:String){products(first:${PAGE_PRODUCTS},after:$after,sortKey:UPDATED_AT,query:$q){pageInfo{hasNextPage endCursor}nodes{id title handle status vendor productType updatedAt featuredMedia{preview{image{url}}}variants(first:100){nodes{id sku title price inventoryQuantity}}}}}`
const Q_PAYOUTS = `query Y($after:String){shopifyPaymentsAccount{payouts(first:${PAGE_PAYOUTS},after:$after){pageInfo{hasNextPage endCursor}nodes{id issuedAt status transactionType net{amount currencyCode}summary{chargesGross{amount}}}}}}`
const Q_SHOP = `query S{shop{currencyCode ianaTimezone}}`
const Q_INVENTORY = `query I($after:String){products(first:${PAGE_PRODUCTS},after:$after){pageInfo{hasNextPage endCursor}nodes{id variants(first:100){nodes{inventoryQuantity}}}}}`

type EntityPage = { raw: RawRow[]; after: string | null; hasNext: boolean }

async function fetchPage(ctx: RunContext, entity: string, since: Date | null, from: Date | null, after: string | null): Promise<EntityPage> {
  if (entity === 'order') {
    const q = since ? `updated_at:>=${since.toISOString()}` : from ? `created_at:>=${from.toISOString()}` : null
    const d = await gql(ctx, Q_ORDERS, { after, q })
    const c = d.orders
    return {
      raw: c.nodes.map((n: Json) => ({ entity, externalId: n.id, sourceUpdatedAt: new Date(n.updatedAt), payload: n })),
      after: c.pageInfo.endCursor ?? null, hasNext: !!c.pageInfo.hasNextPage,
    }
  }
  if (entity === 'product') {
    const q = since ? `updated_at:>=${since.toISOString()}` : null
    const d = await gql(ctx, Q_PRODUCTS, { after, q })
    const c = d.products
    return {
      raw: c.nodes.map((n: Json) => ({ entity, externalId: n.id, sourceUpdatedAt: new Date(n.updatedAt), payload: n })),
      after: c.pageInfo.endCursor ?? null, hasNext: !!c.pageInfo.hasNextPage,
    }
  }
  if (entity === 'payout') {
    const d = await gql(ctx, Q_PAYOUTS, { after })
    const c = d.shopifyPaymentsAccount?.payouts ?? { nodes: [], pageInfo: {} }
    // No API filter: newest-first, stop once we page past `since` (§4.2).
    const nodes = since ? c.nodes.filter((n: Json) => new Date(n.issuedAt) >= since) : c.nodes
    const exhausted = since ? nodes.length < c.nodes.length : false
    return {
      raw: nodes.map((n: Json) => ({ entity, externalId: n.id, sourceUpdatedAt: new Date(n.issuedAt), payload: n })),
      after: c.pageInfo?.endCursor ?? null, hasNext: !exhausted && !!c.pageInfo?.hasNextPage,
    }
  }
  if (entity === 'inventory_snapshot') {
    // Derived: sum variants.inventoryQuantity over every product, once per local day.
    if (await ctx.hasMetricToday('inventory_units')) return { raw: [], after: null, hasNext: false }
    let cur: string | null = null, units = 0
    for (;;) {
      const d: Json = await gql(ctx, Q_INVENTORY, { after: cur })
      for (const p of d.products.nodes) for (const v of p.variants.nodes) units += Number(v.inventoryQuantity ?? 0)
      if (!d.products.pageInfo.hasNextPage) break
      cur = d.products.pageInfo.endCursor
    }
    const day = localDay(new Date(), ctx.timezone)
    return { raw: [{ entity, externalId: day, payload: { day, units } }], after: null, hasNext: false }
  }
  if (entity === 'sessions_day') {
    if (ctx.config.sessions_mode !== 'shopifyql') return { raw: [], after: null, hasNext: false }
    const start = since ?? from ?? new Date(Date.now() - 7 * 864e5)
    const sinceDay = localDay(new Date(start.getTime() - 2 * 864e5), ctx.timezone)
    const d = await gql(ctx, Q_SHOPIFYQL, { q: sessionsQuery(sinceDay) })
    // ShopifyQL reports query mistakes in parseErrors, not GraphQL errors, so gql() doesn't throw on them.
    const parseErrors: string[] = d?.shopifyqlQuery?.parseErrors ?? []
    if (parseErrors.length) throw new SourceError('shopify', `shopifyql: ${parseErrors[0]}`, 200, d)
    // One object per day, keyed by column name. PERCENT is a 0-1 fraction (bounce_rate "1.0" = 2 of 2 sessions, rehearsal
    // 2026-09-14), the same unit as the view's orders/sessions fallback. Days with no sessions come back null: keep null.
    const rows: Json[] = d?.shopifyqlQuery?.tableData?.rows ?? []
    return {
      raw: rows.map((r: Json) => ({ entity, externalId: String(r.day), payload: { day: r.day, sessions: Number(r.sessions ?? 0), conversion_rate: r.conversion_rate == null ? null : Number(r.conversion_rate) } })),
      after: null, hasNext: false,
    }
  }
  return { raw: [], after: null, hasNext: false }
}

/** Run-start refresh of currency + store timezone from the shop itself (§4.2). */
async function shopMeta(ctx: RunContext): Promise<void> {
  const d = await gql(ctx, Q_SHOP)
  const currency = d?.shop?.currencyCode, store_timezone = d?.shop?.ianaTimezone
  if (currency && (currency !== ctx.config.currency || store_timezone !== ctx.config.store_timezone)) {
    await ctx.mergeConfig({ currency, store_timezone })
  }
}

async function* drive(ctx: RunContext, entities: string[], sinceFor: (e: string) => Date | null, from: Date | null, start: { entity?: string; after?: string | null } | null): AsyncGenerator<Page> {
  await shopMeta(ctx)
  let list = entities
  if (start?.entity) {
    const i = list.indexOf(start.entity)
    if (i > 0) list = list.slice(i)
  }
  for (let i = 0; i < list.length; i++) {
    const entity = list[i]
    const lastEntity = i === list.length - 1
    let after: string | null = entity === start?.entity ? (start.after ?? null) : null
    for (;;) {
      const p = await fetchPage(ctx, entity, sinceFor(entity), from, after)
      after = p.after
      const entityDone = !p.hasNext
      const watermark = p.raw.reduce((m, r) => (r.sourceUpdatedAt && r.sourceUpdatedAt > m ? r.sourceUpdatedAt : m), new Date(0))
      yield {
        raw: p.raw,
        entity,
        cursor: entityDone
          ? (watermark.getTime() > 0 ? { updated_at: new Date(watermark.getTime() - 5 * 60_000).toISOString() } : { updated_at: new Date().toISOString() })
          : { entity, after },
        entityDone,
        done: entityDone && lastEntity,
      }
      if (entityDone) break
    }
  }
}

export const shopify: Connector = {
  source: 'shopify',
  defaults: {
    interval: '1 hour',
    backfillDepth: '13 months',
    rateLimit: { concurrency: 1, minDelayMs: 0 },
  },
  configSchema,
  tokenKind: 'shopify_admin',

  backfill(ctx, from, cursor) {
    return drive(ctx, ['product', 'order', 'payout', 'inventory_snapshot'], () => null, from, cursor as Json)
  },

  incremental(ctx, cursors) {
    const since = (e: string) => (cursors?.[e]?.updated_at ? new Date(cursors[e].updated_at) : null)
    return drive(ctx, ['order', 'product', 'payout', 'inventory_snapshot', 'sessions_day'], since, null, null)
  },

  normalize(ctx: RunContext, rows: RawRow[]): CanonicalWrites {
    const money: MoneyRow[] = [], products: ProductRow[] = [], customers: CustomerRow[] = [], dailyMetrics: MetricRow[] = []
    const base = adminUrl(ctx)
    for (const r of rows) {
      const p = r.payload
      if (r.entity === 'order') {
        const occurred = new Date(p.processedAt ?? p.createdAt)
        const cur = p.totalPriceSet?.shopMoney?.currencyCode ?? p.currencyCode
        money.push({
          externalId: p.id, kind: 'order', occurred_at: occurred.toISOString(), day: localDay(occurred, ctx.timezone),
          amount_minor: minor(p.totalPriceSet?.shopMoney?.amount), currency: cur,
          status: p.displayFinancialStatus ?? null, order_number: p.name ?? null,
          customer_external_id: p.customer?.id ?? null,
          items_count: (p.lineItems?.nodes ?? []).reduce((s: number, l: Json) => s + Number(l.quantity ?? 0), 0),
          url: `${base}/orders/${numericId(p.id)}`,
          attributes: {
            fulfillment_status: p.displayFulfillmentStatus ?? null,
            cancelled_at: p.cancelledAt ?? null,
            current_total_minor: minor(p.currentTotalPriceSet?.shopMoney?.amount),
            line_items: (p.lineItems?.nodes ?? []).map((l: Json) => ({
              id: l.id, title: l.title, sku: l.sku, quantity: l.quantity, total_minor: minor(l.discountedTotalSet?.shopMoney?.amount),
            })),
          },
          source_updated_at: p.updatedAt ?? null,
        })
        for (const rf of p.refunds ?? []) {
          const at = new Date(rf.createdAt)
          money.push({
            externalId: rf.id, kind: 'refund', occurred_at: at.toISOString(), day: localDay(at, ctx.timezone),
            amount_minor: -minor(rf.totalRefundedSet?.shopMoney?.amount),
            currency: rf.totalRefundedSet?.shopMoney?.currencyCode ?? cur,
            order_number: p.name ?? null, attributes: { order_external_id: p.id }, source_updated_at: rf.createdAt ?? null,
          })
        }
        if (p.customer?.id) {
          customers.push({ externalId: p.customer.id, email: p.customer.email ?? null, name: p.customer.displayName ?? null, currency: cur, source_updated_at: p.updatedAt ?? null })
        }
      } else if (r.entity === 'payout') {
        const at = new Date(p.issuedAt)
        money.push({
          externalId: p.id, kind: 'payout', occurred_at: at.toISOString(), day: localDay(at, ctx.timezone),
          amount_minor: minor(p.net?.amount), currency: p.net?.currencyCode ?? ctx.config.currency ?? 'USD',
          status: p.status ?? null, attributes: { transaction_type: p.transactionType ?? null, summary: p.summary ?? null },
          source_updated_at: p.issuedAt ?? null,
        })
      } else if (r.entity === 'product') {
        const variants = (p.variants?.nodes ?? []).map((v: Json) => ({
          id: v.id, sku: v.sku, title: v.title, price_minor: minor(v.price), inventory_quantity: Number(v.inventoryQuantity ?? 0),
        }))
        products.push({
          externalId: p.id, title: p.title, handle: p.handle ?? null, status: p.status ?? null, vendor: p.vendor ?? null,
          product_type: p.productType ?? null,
          price_minor: variants.length ? Math.min(...variants.map((v: Json) => v.price_minor)) : null,
          currency: ctx.config.currency ?? null,
          inventory_quantity: variants.reduce((s: number, v: Json) => s + v.inventory_quantity, 0),
          variants_count: variants.length,
          image_url: p.featuredMedia?.preview?.image?.url ?? null,
          url: `${base}/products/${numericId(p.id)}`,
          attributes: { variants }, source_updated_at: p.updatedAt ?? null,
        })
      } else if (r.entity === 'inventory_snapshot') {
        dailyMetrics.push({ day: p.day, entity_kind: 'store', entity_id: 'store', metric: 'inventory_units', value: Number(p.units ?? 0), firstWins: true })
      } else if (r.entity === 'sessions_day') {
        dailyMetrics.push({ day: p.day, entity_kind: 'store', entity_id: 'store', metric: 'sessions', value: Number(p.sessions ?? 0) })
        if (p.conversion_rate != null) {
          dailyMetrics.push({ day: p.day, entity_kind: 'store', entity_id: 'store', metric: 'conversion_rate', value: Number(p.conversion_rate) })
        }
      }
    }
    return { money, products, customers, dailyMetrics }
  },
}
