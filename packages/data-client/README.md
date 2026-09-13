# @bcn-services/data-client

Thin typed wrapper over `@supabase/supabase-js` for the bcns-data shared platform (DESIGN.md §8).
Talks to schema `api` only — nothing else.

## Install

Workspace-internal package (`pnpm-workspace.yaml`). Peer dependency: `@supabase/supabase-js`.

## Usage

```ts
import { createDataClient } from '@bcn-services/data-client'

const dc = createDataClient({
  supabaseUrl: 'https://<project>.supabase.co',
  anonKey: '<anon-key>',
  accessToken: session.access_token, // from the dashboard's own auth flow
})
```

`accessToken` also takes a `() => Promise<string>` getter — passed straight through as
supabase-js's own `accessToken` client option (2.116+, per-request, no `.auth` on the underlying
client). `signIn` below returns a client wired up this way.

### `signIn({ supabaseUrl, anonKey, email, password })`

Signs in with a password (one private, non-persisted auth client) and returns a `DataClient` plus
`accessToken()`, which returns the current token and transparently refreshes it once within 60s of
expiry (concurrent callers share one in-flight refresh; a failed refresh falls back to one more
password sign-in). Throws `Error('sign-in failed: <msg>')` on bad credentials, or `Error('access
token has no client_id claim')` if the session it gets back has no active membership.

```ts
import { signIn } from '@bcn-services/data-client'

const dc = await signIn({ supabaseUrl, anonKey, email: 'agent+acme@bcn-services.com', password })
const { data } = await dc.views.money_v1().order('day', { ascending: false }).limit(10)
```

### `views.<name>_v1()`

Returns a postgrest-js query builder (chain `.eq()`, `.order()`, `.limit()`, …) for every
`api.*_v1` view: `client_v1`, `money_v1`, `daily_metrics_v1`, `daily_summary_v1`,
`campaign_daily_v1`, `creative_daily_v1`, `products_v1`, `customers_v1`, `jobs_v1`,
`messages_v1`, `records_v1`, `media_v1`, `media_sets_v1`, `media_set_items_v1`, `activity_v1`,
`connector_health_v1`, `egress_status_v1`, `memberships_v1`.

```ts
const { data } = await dc.views.money_v1().eq('kind', 'order').order('day', { ascending: false })
```

### `rpc.<name>()`

One wrapper per `api.*` RPC (`save_record`, `delete_record`, `register_upload`, `update_media`,
`bulk_tag`, `delete_media`, `restore_media`, `create_media_set`, `update_media_set`,
`delete_media_set`, `set_media_set_items`, `download_url`, `report_dashboard_version`,
`remove_member`). Typed args/return from the generated `Database` type; throws `DataClientError`
on failure.

```ts
const id = await dc.rpc.save_record({ kind: 'note', attributes: { text: 'hi' } })
```

### `media`

- `media.upload(file, { title, tags })` — uploads to `<client_id>/orig/<uuid>.<ext>`, then calls
  `register_upload`. Returns the media id.
- `media.downloadUrl(mediaId)` — calls `download_url` (charges egress, mints a 5-min ticket) then
  `createSignedUrl(path, 300)`. Returns the signed URL.
- `media.thumbUrls(paths[])` — `createSignedUrls` in batches of 100, never ticketed. Returns
  `{ [path]: signedUrl | null }`.

### `health()`

Reads `client_v1` (one row). Throws `DataClientError` (`no_tenant`) if there's no active tenant.

## Errors

RPC and `health()` failures throw `DataClientError`, mapping the RPC's Postgres SQLSTATE:

| SQLSTATE | `.code` |
|---|---|
| `BCNS0` | `no_tenant` |
| `BCNS1` | `budget_reached` |
| `BCNS2` | `forbidden_role` |
| `BCNS3` | `validation` |
| `BCNS4` | `not_found` |
| `BCNS5` | `too_large` |

`.message`, `.details`, `.hint` mirror the underlying Postgres error. `.sqlstate` carries the raw
`BCNS*` code.

### `agentTools(opts?) / runTool(client, name, input, opts?)`

SDK-agnostic tool definitions for an LLM tool loop (no Anthropic dependency; `input_schema` is
plain JSON Schema, usable as-is for Anthropic `tools` or trivially mapped to others).

- `agentTools({ views?, rpcs? })` returns the tool list: always a `read_view` tool (defaults to
  every view except `customers_v1`/`memberships_v1` — user ids/PII stay out of model context
  unless a repo opts in via `views`), plus one tool per RPC named in `rpcs` (default `[]` — a
  read-only agent). Only `save_record`, `update_media`, `bulk_tag` can ever be exposed; every
  destructive/egress/admin RPC (`delete_*`, `download_url`, `remove_member`, media sets, …) never is.
- `runTool(client, name, input, opts?)` runs one call, validating the model's input at the trust
  boundary — throws `ToolInputError` for an unknown tool, a view/RPC not exposed for the same
  `opts`, a bad column name, a bad filter value, a bad date, an out-of-range limit, or an unknown
  input key. A platform-side failure still throws `DataClientError`.

```ts
import { agentTools, runTool } from '@bcn-services/data-client'

const tools = agentTools({ rpcs: ['save_record'] }) // pass straight to Anthropic's `tools` param
const result = await runTool(dc, 'read_view', { view: 'money_v1', limit: 20 })
```

## Regenerating types

`src/database.types.ts` is generated, not hand-written: `pnpm db:types` (root script) against the
local stack's `api` schema.
