// DESIGN.md §9 onboarding checklist. One function per source: throws on a failed item (stops onboard),
// returns config patches + warnings. `fetch` is injectable so the refusals are unit-testable offline.
import type { Source } from '../worker/src/connectors/index.js'
import { shopifyEndpoint } from '../worker/src/connectors/shopify-url.js'

export interface Creds {
  secret: string; refresh_secret?: string; attributes?: Record<string, unknown>; config: Record<string, unknown>
}
export interface Verdict { config: Record<string, unknown>; warnings: string[] }
type Fetch = typeof globalThis.fetch

const SHOPIFY_SCOPES = ['read_orders', 'read_all_orders', 'read_products', 'read_inventory', 'read_shopify_payments_payouts', 'read_reports', 'read_customers']

async function gql(fetch: Fetch, url: string, headers: Record<string, string>, query: string): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ query }) })
  const b: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return b
}

export async function checklist(source: Source, tz: string, c: Creds, fetch: Fetch = globalThis.fetch): Promise<Verdict> {
  const warnings: string[] = []
  const config: Record<string, unknown> = {}
  const warnTz = (id: string, other: unknown) => { if (other && other !== tz) warnings.push(`${id}: ${source} timezone ${other} ≠ clients.timezone ${tz} (U2: confirm with the owner, record the choice in clients.notes)`) }

  if (source === 'shopify') {
    // S1/S2 are decided by the scope query alone: both connection methods in docs/shopify-connection-method.md
    // mint tokens with no documented prefix, so a prefix check would reject valid tokens.
    const url = shopifyEndpoint(c.config.shop)
    const h = { 'X-Shopify-Access-Token': c.secret }
    const scopes = await gql(fetch, url, h, '{ currentAppInstallation { accessScopes { handle } } shop { ianaTimezone currencyCode } }')
    const have = new Set<string>((scopes.data?.currentAppInstallation?.accessScopes ?? []).map((s: any) => s.handle))
    const missing = SHOPIFY_SCOPES.filter((s) => !have.has(s))
    if (missing.length) throw new Error(`${missing.includes('read_all_orders') ? 'S2' : 'S1'}: missing scopes ${missing.join(', ')}`)
    config.store_timezone = scopes.data.shop.ianaTimezone; config.currency = scopes.data.shop.currencyCode // S3, S5
    warnTz('S5', config.store_timezone)
    const probe = await gql(fetch, url, h, '{ shopifyqlQuery(query: "FROM sessions SHOW sessions SINCE -1d UNTIL today") { __typename } }')
    config.sessions_mode = probe.errors ? 'none' : 'shopifyql' // S4
  }

  if (source === 'meta') {
    const g = 'https://graph.facebook.com/v21.0'
    const dbg: any = await (await fetch(`${g}/debug_token?input_token=${c.secret}&access_token=${c.secret}`)).json()
    if (dbg.data?.type !== 'SYSTEM_USER') throw new Error(`M1: token type ${dbg.data?.type ?? 'unknown'}, need SYSTEM_USER`)
    const acct: any = await (await fetch(`${g}/${c.config.act_id}?fields=timezone_name,currency&access_token=${c.secret}`)).json()
    if (acct.error || !acct.timezone_name) throw new Error(`M2: ${c.config.act_id} not readable (${acct.error?.message ?? 'no ads_read'})`)
    config.account_timezone = acct.timezone_name; config.currency = acct.currency
    warnTz('M3', acct.timezone_name)
  }

  if (source === 'monday') {
    const b = await gql(fetch, 'https://api.monday.com/v2', { Authorization: c.secret }, `{ boards(ids: [${c.config.board_id}]) { columns { id title type } } }`)
    const cols: any[] = b.data?.boards?.[0]?.columns ?? []
    const byType = (t: string) => cols.find((x) => x.type === t)?.id
    const byTitle = (re: RegExp) => cols.find((x) => re.test(x.title))?.id
    const status = byTitle(/^status$/i) ?? byType('status')
    if (!status) throw new Error('D1: no Status column on the board')
    config.columns = Object.fromEntries(Object.entries({
      status, due: byType('date'), owner: byType('people'), priority: byTitle(/priority/i), link: byType('link'),
    }).filter(([, v]) => v))
  }

  if (source === 'meet' || source === 'drive') {
    const clientId = String(c.config.oauth_client_id ?? '')
    if (process.env.BCNS_OAUTH_CLIENT_ID && clientId === process.env.BCNS_OAUTH_CLIENT_ID) throw new Error('G1: bcns OAuth client; the app must live in the client\'s own Workspace (Internal)')
    const tok: any = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_secret ?? '', client_id: clientId,
        client_secret: String(c.attributes?.oauth_client_secret ?? '') }).toString() })).json()
    if (!tok.access_token) throw new Error(`G1: refresh failed (${tok.error_description ?? tok.error ?? 'no access_token'})`)
    const info: any = await (await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${tok.access_token}`)).json()
    if (info.aud && info.aud !== clientId) throw new Error(`G1: token audience ${info.aud} ≠ oauth_client_id`)
    const q = encodeURIComponent(`'${c.config.folder_id}' in parents and trashed=false` + (source === 'meet' ? ` and mimeType='application/vnd.google-apps.document'` : ` and mimeType != 'application/vnd.google-apps.folder'`))
    const files: any = await (await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1&fields=files(id)`,
      { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()
    if (!files.files?.length) throw new Error(source === 'meet' ? 'G2: no readable Gemini notes doc in the folder' : 'G2: no readable file in the Drive folder')
    config.access_token = tok.access_token; config.expires_in = tok.expires_in ?? 3600
  }
  return { config, warnings }
}
