// §4.1 connector module contract + registry + shared helpers.
import type { ZodTypeAny } from 'zod'

export type Json = any
export type Source = 'shopify' | 'meta' | 'monday' | 'meet' | 'drive'
export type TokenKind = 'shopify_admin' | 'monday_personal' | 'meta_system_user' | 'google_oauth_refresh'
export type CanonTable = 'jobs' | 'records' | 'media'

export interface RawRow { entity: string; externalId: string; sourceUpdatedAt?: Date; payload: Json }
export interface Page { raw: RawRow[]; entity: string; cursor: Json; entityDone: boolean; done: boolean }

export interface MoneyRow {
  externalId: string; kind: 'order' | 'refund' | 'payout'; occurred_at: string; day: string
  amount_minor: number; currency: string; status?: string | null; order_number?: string | null
  customer_external_id?: string | null; items_count?: number | null; url?: string | null
  attributes?: Json; source_updated_at?: string | null
}
export interface JobRow {
  externalId: string; kind: string; title: string; status?: string | null; is_done: boolean
  priority?: string | null; group_name?: string | null; owner?: string | null; due_on?: string | null
  url?: string | null; attributes?: Json; source_updated_at?: string | null
}
export interface MessageRow {
  externalId: string; kind: string; title?: string | null; body?: string | null; occurred_at: string
  participants?: string[] | null; url?: string | null; attributes?: Json; source_updated_at?: string | null
}
export interface MediaRow {
  externalId: string; kind: 'image' | 'video' | 'file'; storage_path?: string | null; thumb_path?: string | null; filename: string
  mime?: string | null; bytes?: number | null; width?: number | null; height?: number | null
  title?: string | null; tags?: string[]; attributes?: Json; source_updated_at?: string | null
}
export interface ProductRow {
  externalId: string; title: string; handle?: string | null; status?: string | null; vendor?: string | null
  product_type?: string | null; price_minor?: number | null; currency?: string | null
  inventory_quantity?: number | null; variants_count?: number | null; image_url?: string | null
  url?: string | null; attributes?: Json; source_updated_at?: string | null
}
export interface CustomerRow {
  externalId: string; email?: string | null; name?: string | null; first_order_at?: string | null
  orders_count?: number | null; total_spent_minor?: number | null; currency?: string | null
  attributes?: Json; source_updated_at?: string | null
}
export interface RecordRow {
  externalId: string; kind: string; title?: string | null; body?: string | null; occurred_at: string
  attributes?: Json; source_updated_at?: string | null
}
/** `firstWins` upserts `on conflict do nothing` (§4.2 inventory_snapshot). */
export interface MetricRow {
  day: string; entity_kind: string; entity_id: string; metric: string; value: number
  currency?: string | null; firstWins?: boolean
}

export interface CanonicalWrites {
  money?: MoneyRow[]; products?: ProductRow[]; jobs?: JobRow[]; messages?: MessageRow[]
  media?: MediaRow[]; dailyMetrics?: MetricRow[]; records?: RecordRow[]; customers?: CustomerRow[]
}

export interface TokenRow {
  client_id: string; source: Source; kind: TokenKind; secret: string
  refresh_secret: string | null; expires_at: Date | null; attributes: Json
}

export interface RunContext {
  clientId: string
  source: Source
  token: TokenRow
  config: Json
  timezone: string
  /** Rate-limited per (source, client_id) — never process-wide (R26). */
  fetch: typeof globalThis.fetch
  log: (event: string, data?: Record<string, unknown>) => void
  putObject(path: string, bytes: Uint8Array, mime: string): Promise<void>
  /** §4.2: the once-per-local-day inventory snapshot fires only when today's row is absent. */
  hasMetricToday(metric: string): Promise<boolean>
  /** §4.3: which of these media external_ids already exist, so creatives download once. */
  knownMedia(externalIds: string[]): Promise<Set<string>>
  /** §4.2/§4.3: run-start write-back of source-reported currency/timezone into config. */
  mergeConfig(patch: Record<string, unknown>): Promise<void>
}

export interface Connector {
  source: Source
  defaults: {
    interval: string
    backfillDepth: string
    rateLimit: { concurrency: number; minDelayMs: number }
    fullList?: { entity: string; table: CanonTable }[]
  }
  configSchema: ZodTypeAny
  tokenKind: TokenKind
  backfill(ctx: RunContext, from: Date, cursor: Json | null): AsyncIterable<Page>
  incremental(ctx: RunContext, cursors: Record<string, Json>): AsyncIterable<Page>
  refreshToken?(ctx: RunContext): Promise<{ secret: string; expiresAt: Date }>
  normalize(ctx: RunContext, rows: RawRow[]): CanonicalWrites
}

// ------------------------------------------------------------------ shared helpers

export class SourceError extends Error {
  constructor(public source: Source, message: string, public status?: number, public body?: Json) {
    super(message)
    this.name = 'SourceError'
  }
}

/** §1.5 local_day, computed worker-side for bulk inserts. */
export const localDay = (ts: Date, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts)

/** Decimal string/number → integer minor units. */
export const minor = (amount: unknown): number => Math.round(Number(amount ?? 0) * 100)

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** §5.3 step 5: never let a credential reach connector_schedule.last_error. */
export function redact(message: string): string {
  return message
    .replace(/access_token=[^&\s]*/gi, 'access_token=***')
    .replace(/(shp[a-z]{2}_)\w+/g, '$1***') // shpat_ custom-app, shpua_ OAuth install, shpca_/shppa_/shpss_
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/(x-shopify-access-token|authorization)\s*[:=]\s*\S+/gi, '$1: ***')
    .replace(/\?\S*/g, '')
    .slice(0, 300)
}

export type ErrorClass = 'throttle' | 'auth' | 'error'

/** §5.3 step 5: source error body first, HTTP status second. */
export function classify(e: unknown): ErrorClass {
  if (!(e instanceof SourceError)) return 'error'
  const { status, body, source } = e
  const text = JSON.stringify(body ?? '') + ' ' + e.message
  if (status === 429) return 'throttle'
  if (source === 'shopify') {
    if (/"THROTTLED"/.test(text)) return 'throttle'
    if (status === 401 || /"ACCESS_DENIED"/.test(text)) return 'auth'
  }
  if (source === 'meta') {
    const err = body?.error ?? {}
    if ([4, 17, 32, 613].includes(Number(err.code)) || err.is_transient === true) return 'throttle'
    const sub = Number(err.error_subcode)
    if (Number(err.code) === 190 || (err.type === 'OAuthException' && sub >= 458 && sub <= 467)) return 'auth'
  }
  if (source === 'monday') {
    if (/ComplexityException/.test(text)) return 'throttle'
    if (/USER_UNAUTHORIZED/.test(text)) return 'auth'
  }
  if (source === 'meet' || source === 'drive') {
    if (status === 403 && /(userR|r)ateLimitExceeded/.test(text)) return 'throttle'
    if (status === 401 || /invalid_grant/.test(text)) return 'auth'
  }
  return 'error'
}

// ------------------------------------------------------------------ registry
import { shopify } from './shopify.js'
import { meta } from './meta.js'
import { monday } from './monday.js'
import { meet } from './meet.js'
import { drive } from './drive.js'

export const connectors: Record<Source, Connector> = { shopify, meta, monday, meet, drive }

/** Sources whose connector declares a fullList entity — the only ones the §5.5 zero-row rule applies to. */
export const fullListSources: Source[] = (Object.keys(connectors) as Source[]).filter(
  s => (connectors[s].defaults.fullList?.length ?? 0) > 0,
)

/** source -> its fullList entity names; §5.5's zero-row rule is judged per entity. */
export const fullListEntities: Partial<Record<Source, string[]>> = Object.fromEntries(
  fullListSources.map(s => [s, connectors[s].defaults.fullList!.map(f => f.entity)]))
