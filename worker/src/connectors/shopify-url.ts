// Shopify helpers with no imports: safe to load from scripts before the connector registry
// (connectors/index.ts <-> shopify.ts is a cycle that only tolerates index.ts as the entry point).
export const API_VERSION = '2026-07'

/** `foo`, `foo.myshopify.com`, `https://foo.myshopify.com/` → `foo`. The store handle is the first label. */
export const shopHandle = (shop: unknown): string =>
  String(shop ?? '').trim().replace(/^https?:\/\//i, '').split('/')[0].split('.')[0]

/** Admin GraphQL endpoint for a `shop` in any of the forms an operator might type. Shared with worker/src/tokens.ts and scripts/checklist.ts. */
export const shopifyEndpoint = (shop: unknown) =>
  `https://${shopHandle(shop)}.myshopify.com/admin/api/${API_VERSION}/graphql.json`

/** ShopifyQL daily sessions + conversion rate. Shared by the worker (sessions_day) and checklist S4 so the probe runs the real query. */
export const Q_SHOPIFYQL = 'query Q($q:String!){shopifyqlQuery(query:$q){parseErrors tableData{rows}}}'
export const sessionsQuery = (since: string) => `FROM sessions SHOW sessions, conversion_rate TIMESERIES day SINCE ${since} UNTIL today`
