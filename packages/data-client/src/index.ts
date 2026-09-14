// @bcn-services/data-client — thin typed wrappers over supabase-js for the shared-platform dashboard
// contract (DESIGN.md §8). Nothing beyond what §8 lists: views, rpc, media, health.
import { createClient, PostgrestError, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types.js'

export type { Database } from './database.types.js'

export interface CreateDataClientOptions {
  supabaseUrl: string
  anonKey: string
  /** Bearer token for the signed-in dashboard user (e.g. from supabase-js auth elsewhere in the
   *  template). Required for anything beyond an anonymous read. Not in DESIGN.md §8's literal
   *  signature — NOTES: taken as the way an already-authenticated session reaches this package,
   *  since §8 says the returned object exposes "nothing else" (no `.auth`).
   *  A function form is passed straight through as supabase-js's `accessToken` client option
   *  (2.116+): a fresh, per-request token with no `.auth` on the underlying client — see `signIn`. */
  accessToken?: string | (() => Promise<string>)
}

// ---- errors (DESIGN.md §3.3) ------------------------------------------------------------------

export type DataClientErrorCode =
  | 'no_tenant'
  | 'budget_reached'
  | 'forbidden_role'
  | 'validation'
  | 'not_found'
  | 'too_large'
  | 'unknown'

const SQLSTATE_CODES: Record<string, DataClientErrorCode> = {
  BCNS0: 'no_tenant',
  BCNS1: 'budget_reached',
  BCNS2: 'forbidden_role',
  BCNS3: 'validation',
  BCNS4: 'not_found',
  BCNS5: 'too_large',
}

export class DataClientError extends Error {
  readonly code: DataClientErrorCode
  readonly sqlstate: string
  readonly details: string
  readonly hint: string

  constructor(pgError: PostgrestError) {
    super(pgError.message)
    this.name = 'DataClientError'
    this.sqlstate = pgError.code
    this.code = SQLSTATE_CODES[pgError.code] ?? 'unknown'
    this.details = pgError.details
    this.hint = pgError.hint
  }
}

// ---- views (DESIGN.md §3.2) -------------------------------------------------------------------

type Api = Database['api']
type ViewName = keyof Api['Views']

// Hardcoded from supabase/migrations/20260912000400_api_views.sql — a new view needs an entry here.
const VIEW_NAMES = [
  'client_v1',
  'money_v1',
  'daily_metrics_v1',
  'daily_summary_v1',
  'campaign_daily_v1',
  'creative_daily_v1',
  'products_v1',
  'customers_v1',
  'jobs_v1',
  'messages_v1',
  'records_v1',
  'media_v1',
  'media_sets_v1',
  'media_set_items_v1',
  'activity_v1',
  'connector_health_v1',
  'egress_status_v1',
  'memberships_v1',
] as const satisfies readonly ViewName[]

function viewBuilder<K extends ViewName>(client: SupabaseClient<Database, 'api'>, name: K) {
  // `columns` narrows the fetched fields; rows stay typed as the full view row.
  return (columns = '*') => client.from(name).select(columns as '*')
}

type ViewsNamespace = { [K in (typeof VIEW_NAMES)[number]]: ReturnType<typeof viewBuilder<K>> }

function buildViews(client: SupabaseClient<Database, 'api'>): ViewsNamespace {
  const out = {} as ViewsNamespace
  for (const name of VIEW_NAMES) (out as any)[name] = viewBuilder(client, name)
  return out
}

// ---- rpc (DESIGN.md §3.3) ----------------------------------------------------------------------

type Functions = Api['Functions']
type RpcName = keyof Functions

// Hardcoded from supabase/migrations/20260912000500_api_rpcs.sql — a new RPC needs an entry here.
const RPC_NAMES = [
  'save_record',
  'delete_record',
  'register_upload',
  'update_media',
  'bulk_tag',
  'delete_media',
  'restore_media',
  'create_media_set',
  'update_media_set',
  'delete_media_set',
  'set_media_set_items',
  'reorder_media_set_items',
  'download_url',
  'report_dashboard_version',
  'remove_member',
] as const satisfies readonly RpcName[]

type RpcNamespace = {
  [K in (typeof RPC_NAMES)[number]]: (args: Functions[K]['Args']) => Promise<Functions[K]['Returns']>
}

function buildRpc(client: SupabaseClient<Database, 'api'>): RpcNamespace {
  const out = {} as RpcNamespace
  for (const name of RPC_NAMES) {
    ;(out as any)[name] = async (args: unknown) => {
      const { data, error } = await client.rpc(name as any, args as any)
      if (error) throw new DataClientError(error)
      return data
    }
  }
  return out
}

// ---- media (DESIGN.md §2.5, §3.3) ---------------------------------------------------------------

export interface MediaUploadOptions {
  title?: string
  tags?: string[]
}

/** client_id claim from an authenticated JWT (decode-only, no verification — the server verifies). */
function decodeClientId(accessToken: string | undefined): string {
  if (!accessToken) throw new Error('createDataClient: accessToken required for this call')
  const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'))
  if (typeof claims.client_id !== 'string') throw new Error('access token has no client_id claim')
  return claims.client_id
}

function extFromFile(file: File | Blob): string {
  const name = 'name' in file ? (file as File).name : ''
  const dot = name.lastIndexOf('.')
  const raw = dot > -1 ? name.slice(dot + 1) : file.type.split('/')[1] ?? ''
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
  return cleaned || 'bin'
}

function buildMedia(client: SupabaseClient<Database, 'api'>, rpc: RpcNamespace, getToken: () => Promise<string | undefined>) {
  return {
    /** Storage upload to `<client_id>/orig/<uuid>.<ext>`, then `register_upload`. Returns the media id. */
    async upload(file: File | Blob, opts: MediaUploadOptions = {}): Promise<string> {
      const clientId = decodeClientId(await getToken())
      const path = `${clientId}/orig/${crypto.randomUUID()}.${extFromFile(file)}`
      const { error } = await client.storage.from('media').upload(path, file)
      if (error) throw error
      return rpc.register_upload({ path, title: opts.title, tags: opts.tags })
    },

    /** `download_url` (mints a 5-min egress ticket) then `createSignedUrl(path, 300)`. */
    async downloadUrl(mediaId: string): Promise<string> {
      const ticket = (await rpc.download_url({ media_id: mediaId })) as { path: string }
      const { data, error } = await client.storage.from('media').createSignedUrl(ticket.path, 300)
      if (error) throw error
      return data.signedUrl
    },

    /** Thumbnails: no ticket, `createSignedUrls` in batches of 100. Returns path -> signed URL
     *  (null on a per-path error). NOTES: DESIGN.md doesn't state a thumbnail URL lifetime —
     *  reused the 300s (5 min) already used for `download_url`'s ticket. */
    async thumbUrls(paths: string[]): Promise<Record<string, string | null>> {
      const out: Record<string, string | null> = {}
      for (let i = 0; i < paths.length; i += 100) {
        const batch = paths.slice(i, i + 100)
        const { data, error } = await client.storage.from('media').createSignedUrls(batch, 300)
        if (error) throw error
        for (const row of data) if (row.path) out[row.path] = row.signedUrl
      }
      return out
    },
  }
}

// ---- createDataClient ---------------------------------------------------------------------------

export interface DataClient {
  views: ViewsNamespace
  rpc: RpcNamespace
  media: ReturnType<typeof buildMedia>
  health: () => Promise<Api['Views']['client_v1']['Row']>
}

/** Typed supabase-js client scoped to schema `api` only, wrapped per DESIGN.md §8. Nothing else. */
export function createDataClient(opts: CreateDataClientOptions): DataClient {
  const tokenFn = typeof opts.accessToken === 'function' ? opts.accessToken : undefined
  const tokenStr = typeof opts.accessToken === 'string' ? opts.accessToken : undefined

  const client = createClient<Database, 'api'>(opts.supabaseUrl, opts.anonKey, {
    db: { schema: 'api' },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(tokenFn ? { accessToken: tokenFn } : {}),
    ...(tokenStr ? { global: { headers: { Authorization: `Bearer ${tokenStr}` } } } : {}),
  })

  const rpc = buildRpc(client)
  const getToken = tokenFn ?? (async () => tokenStr)

  return {
    views: buildViews(client),
    rpc,
    media: buildMedia(client, rpc, getToken),
    async health() {
      const { data, error } = await client.from('client_v1').select('*').single()
      if (error) throw new DataClientError(error)
      return data
    },
  } as DataClient
}

// ---- signIn (DESIGN.md §8 — agent/dashboard auth, no invite mail needed) -----------------------

export interface SignInOptions {
  supabaseUrl: string
  anonKey: string
  email: string
  password: string
}

export interface SignedInDataClient extends DataClient {
  /** Current access token; refreshes when within 60s of expiry. */
  accessToken(): Promise<string>
}

/** One private auth client, one password sign-in. Reused for `createDataClient`'s per-request
 *  token getter — see DESIGN.md §8's Agent-tools addition. */
export async function signIn(opts: SignInOptions): Promise<SignedInDataClient> {
  const auth = createClient(opts.supabaseUrl, opts.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const first = await auth.auth.signInWithPassword({ email: opts.email, password: opts.password })
  if (first.error || !first.data.session) throw new Error(`sign-in failed: ${first.error?.message ?? 'no session'}`)
  decodeClientId(first.data.session.access_token) // throws 'access token has no client_id claim'

  let session = first.data.session
  let inFlight: Promise<string> | null = null

  async function refreshOrSignIn(): Promise<string> {
    const refreshed = await auth.auth.refreshSession({ refresh_token: session.refresh_token })
    if (!refreshed.error && refreshed.data.session) {
      session = refreshed.data.session
      return session.access_token
    }
    const retry = await auth.auth.signInWithPassword({ email: opts.email, password: opts.password })
    if (retry.error || !retry.data.session) throw new Error(`sign-in failed: ${retry.error?.message ?? 'no session'}`)
    session = retry.data.session
    return session.access_token
  }

  async function accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    if (session.expires_at !== undefined && session.expires_at - 60 > now) return session.access_token
    if (!inFlight) {
      inFlight = refreshOrSignIn()
        .then((token) => { inFlight = null; return token })
        .catch((err) => { inFlight = null; throw err })
    }
    return inFlight
  }

  return { ...createDataClient({ supabaseUrl: opts.supabaseUrl, anonKey: opts.anonKey, accessToken }), accessToken }
}

// ---- agent tools (SDK-agnostic; DESIGN.md §8 agent addition) ------------------------------------

export type AgentViewName = ViewName
export type AgentRpcName = 'save_record' | 'update_media' | 'bulk_tag'

export interface AgentToolsOptions {
  views?: AgentViewName[]
  rpcs?: AgentRpcName[]
}

export type JSONSchemaObject = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties: false
}

export interface AgentTool {
  name: string
  description: string
  input_schema: JSONSchemaObject
}

export class ToolInputError extends Error {}

/** User ids / customer PII stay out of model context unless a repo opts in via `views`. */
const DEFAULT_AGENT_VIEWS = VIEW_NAMES.filter(
  (v): v is AgentViewName => v !== 'memberships_v1' && v !== 'customers_v1',
)

/** Hardcoded from supabase/migrations/20260912000400_api_views.sql — a new view needs an entry
 *  (or none, if it has no natural date column) here and in VIEW_DESCRIPTIONS. */
const VIEW_DATE_COLUMN: Partial<Record<ViewName, string>> = {
  daily_summary_v1: 'day',
  daily_metrics_v1: 'day',
  campaign_daily_v1: 'day',
  creative_daily_v1: 'day',
  money_v1: 'occurred_at',
  activity_v1: 'occurred_at',
  messages_v1: 'occurred_at',
  records_v1: 'occurred_at',
  media_v1: 'created_at',
  media_sets_v1: 'created_at',
  jobs_v1: 'source_updated_at',
}

const VIEW_DESCRIPTIONS: Record<ViewName, string> = {
  client_v1: 'Tenant identity, timezone, status, egress quota. One row.',
  money_v1: 'Orders, refunds, payouts ledger.',
  daily_metrics_v1: 'Per-day metric rows (sessions, spend, impressions, …).',
  daily_summary_v1: 'One row per day: revenue, orders, ad spend/purchases rollup.',
  campaign_daily_v1: 'Meta ad campaign daily performance.',
  creative_daily_v1: 'Meta ad creative daily performance.',
  products_v1: 'Product catalog.',
  customers_v1: 'Customer directory (PII — excluded by default).',
  jobs_v1: 'Task/job records from connected sources.',
  messages_v1: 'Meeting notes and messages.',
  records_v1: 'Free-form saved records, including AI-generated briefings.',
  media_v1: 'Uploaded and synced media files.',
  media_sets_v1: 'Media collections.',
  media_set_items_v1: 'Media-set membership rows.',
  activity_v1: 'Unified activity feed across connected sources.',
  connector_health_v1: 'Per-connector sync status.',
  egress_status_v1: 'Download-budget usage.',
  memberships_v1: 'User/role rows (user ids — excluded by default).',
}

const COLUMN_RE = /^[a-z_][a-z0-9_]{0,62}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type RpcFieldSchema = { type: string; format?: string; items?: { type: string; format?: string }; maxItems?: number }

/** Hand-written type/shape check for one RPC field against its schema — no schema library. */
function checkRpcField(field: string, value: unknown, schema: RpcFieldSchema): void {
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new ToolInputError(`bad ${field}: expected string`)
    if (schema.format === 'uuid' && !UUID_RE.test(value)) throw new ToolInputError(`bad ${field}: not a uuid`)
  } else if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ToolInputError(`bad ${field}: expected object`)
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new ToolInputError(`bad ${field}: expected array`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new ToolInputError(`bad ${field}: exceeds max of ${schema.maxItems} items`)
    }
    for (const item of value) {
      if (schema.items?.type === 'string') {
        if (typeof item !== 'string') throw new ToolInputError(`bad ${field}: expected string items`)
        if (schema.items.format === 'uuid' && !UUID_RE.test(item)) throw new ToolInputError(`bad ${field}: item not a uuid`)
      }
    }
  }
}

function agentViews(opts?: AgentToolsOptions): AgentViewName[] {
  return opts?.views ?? DEFAULT_AGENT_VIEWS
}

function readViewTool(opts?: AgentToolsOptions): AgentTool {
  const views = agentViews(opts)
  const lines = views.map((v) => {
    const dateCol = VIEW_DATE_COLUMN[v as ViewName]
    return `- ${v}: ${VIEW_DESCRIPTIONS[v as ViewName]}${dateCol ? ` (date column: ${dateCol})` : ''}`
  })
  return {
    name: 'read_view',
    description: `Read rows from a bcns platform view, scoped to the caller's tenant by row-level security.\n${lines.join('\n')}`,
    input_schema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: views },
        columns: { type: 'array', items: { type: 'string' } },
        filters: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            properties: { column: { type: 'string' }, value: {} },
            required: ['column', 'value'],
          },
        },
        date_from: { type: 'string', description: 'YYYY-MM-DD' },
        date_to: { type: 'string', description: 'YYYY-MM-DD' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['view'],
      additionalProperties: false,
    },
  }
}

const RPC_TOOL_SCHEMAS: Record<AgentRpcName, JSONSchemaObject> = {
  save_record: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      attributes: { type: 'object' },
      external_id: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      occurred_at: { type: 'string' },
    },
    required: ['kind', 'attributes'],
    additionalProperties: false,
  },
  update_media: {
    type: 'object',
    properties: {
      media_id: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 50 },
    },
    required: ['media_id'],
    additionalProperties: false,
  },
  bulk_tag: {
    type: 'object',
    properties: {
      media_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 500 },
      add: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      remove: { type: 'array', items: { type: 'string' }, maxItems: 50 },
    },
    required: ['media_ids'],
    additionalProperties: false,
  },
}

const RPC_TOOL_DESCRIPTIONS: Record<AgentRpcName, string> = {
  save_record: 'Save (upsert) a free-form record for this tenant, visible via records_v1.',
  update_media: 'Rename/retag one of this tenant\'s media items.',
  bulk_tag: 'Add or remove tags on up to 500 of this tenant\'s media items.',
}

/** Tool defs for the given options — always `read_view`, plus one tool per opted-in RPC (default
 *  none: a read-only agent). Destructive/egress/admin RPCs are never exposed. */
export function agentTools(opts?: AgentToolsOptions): AgentTool[] {
  const tools: AgentTool[] = [readViewTool(opts)]
  for (const name of opts?.rpcs ?? []) {
    tools.push({ name, description: RPC_TOOL_DESCRIPTIONS[name], input_schema: RPC_TOOL_SCHEMAS[name] })
  }
  return tools
}

function checkColumn(name: string): void {
  if (!COLUMN_RE.test(name)) throw new ToolInputError(`bad column name: ${name}`)
}

function checkFilterValue(value: unknown): void {
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
    throw new ToolInputError(`bad filter value: ${JSON.stringify(value)}`)
  }
}

function checkDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new ToolInputError(`bad ${field}: ${JSON.stringify(value)}`)
  return value
}

function addOneDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

async function runReadView(client: DataClient, input: any, opts?: AgentToolsOptions): Promise<unknown> {
  const allowed = new Set(agentViews(opts))
  const {
    view, columns, filters, date_from: dateFrom, date_to: dateTo, order, limit,
    ...rest
  } = input ?? {}
  const unknownKeys = Object.keys(rest)
  if (unknownKeys.length > 0) throw new ToolInputError(`unknown input keys: ${unknownKeys.join(', ')}`)
  if (typeof view !== 'string' || !allowed.has(view as AgentViewName)) throw new ToolInputError(`unknown or unexposed view: ${view}`)

  const dateCol = VIEW_DATE_COLUMN[view as ViewName]
  if ((dateFrom !== undefined || dateTo !== undefined || order !== undefined) && !dateCol) {
    throw new ToolInputError(`${view} has no date column for range/order`)
  }
  if (columns !== undefined) {
    if (!Array.isArray(columns)) throw new ToolInputError('columns must be an array')
    for (const c of columns) checkColumn(c)
  }
  if (filters !== undefined) {
    if (!Array.isArray(filters) || filters.length > 10) throw new ToolInputError('filters must be an array of at most 10 entries')
    for (const f of filters) {
      if (typeof f !== 'object' || f === null || typeof f.column !== 'string') throw new ToolInputError('bad filter')
      checkColumn(f.column)
      checkFilterValue(f.value)
    }
  }
  if (order !== undefined && order !== 'asc' && order !== 'desc') throw new ToolInputError(`bad order: ${order}`)
  const rowLimit = limit === undefined ? 50 : limit
  if (typeof rowLimit !== 'number' || !Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 200) {
    throw new ToolInputError(`bad limit: ${limit}`)
  }

  // Select only what was asked for (plus the date column, if needed for order/range but not
  // itself requested) instead of `select('*')` + client-side trimming.
  let selectCols = '*'
  if (columns !== undefined) {
    const needed = new Set<string>(columns)
    if (dateCol && (dateFrom !== undefined || dateTo !== undefined || order !== undefined)) needed.add(dateCol)
    selectCols = [...needed].join(',')
  }

  let q: any = (client.views as Record<string, (columns?: string) => unknown>)[view](selectCols)
  for (const f of filters ?? []) q = q.eq(f.column, f.value)
  if (dateFrom !== undefined) q = q.gte(dateCol, checkDate(dateFrom, 'date_from'))
  if (dateTo !== undefined) {
    const d = checkDate(dateTo, 'date_to')
    q = dateCol === 'day' ? q.lte(dateCol, d) : q.lt(dateCol, addOneDay(d))
  }
  if (dateCol) q = q.order(dateCol, { ascending: order === 'asc' })
  q = q.limit(rowLimit)

  const { data, error } = await q
  if (error) throw new DataClientError(error)
  const rows = data
  return { rows, count: rows.length, truncated: rows.length === rowLimit }
}

/** Runs one agent tool call. `opts` must match what produced `name` via `agentTools` — an
 *  unexposed view/RPC for these opts is rejected the same as an unknown one. Model output is
 *  untrusted: every input is validated at this boundary before it reaches the database. */
export async function runTool(client: DataClient, name: string, input: unknown, opts?: AgentToolsOptions): Promise<unknown> {
  const exposed = new Set(agentTools(opts).map((t) => t.name))
  if (!exposed.has(name)) throw new ToolInputError(`unknown or unexposed tool: ${name}`)

  if (name === 'read_view') return runReadView(client, input, opts)

  const rpcName = name as AgentRpcName
  const schema = RPC_TOOL_SCHEMAS[rpcName]
  const body = (input ?? {}) as Record<string, unknown>
  const unknownKeys = Object.keys(body).filter((k) => !(k in schema.properties))
  if (unknownKeys.length > 0) throw new ToolInputError(`unknown input keys: ${unknownKeys.join(', ')}`)
  for (const req of schema.required ?? []) {
    if (!(req in body)) throw new ToolInputError(`missing required field: ${req}`)
  }
  for (const [field, value] of Object.entries(body)) {
    checkRpcField(field, value, schema.properties[field] as RpcFieldSchema)
  }
  return (client.rpc as any)[rpcName](body)
}
