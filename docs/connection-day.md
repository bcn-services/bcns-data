# Connection day runbook — SaunaBoy (`sb`)

SB is onboarded on hosted Supabase with 0 sources. When Declan sends connection info, attaching
each source is one `add-source` command. This doc is the checklist for that day.

## 1. Preflight

- All hosted commands are **Nate-run**, in Nate's own terminal, with hosted env exported
  (`DATABASE_URL` = session pooler URL, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). Claude never
  reads `.env.local`/`.env.production` and never runs anything against hosted — no MCP
  `execute_sql` on the hosted project, no `DATABASE_URL` pointed at hosted. Hosted runs are
  wizard-confirmed, not autopiloted.
- The worker must already be deployed (Cloud Run, chunk 3) before the first source is attached —
  without it, rows never appear; `add-source` will still print success because it only writes
  `source_tokens`/`connector_schedule`, it does not pull data.
- `add-source` ships in `scripts/add-source.ts` on branch `feat/add-source` (PR #3). Merge that
  PR (`! GITHUB_TOKEN= gh pr merge 3`) before connection day.
- Command form, run from `~/bcns-data` on `main` with hosted env exported:
  ```
  corepack pnpm tsx scripts/add-source.ts --slug sb --source <shopify|meta|monday|meet|drive> [--reset-cursors]
  ```
  On success it prints `attached <source> to sb (<id>); next pull <timestamp>` — or `schedule
  disabled` / `client paused` if nothing will pull.
- Confirm SB's `clients.timezone` before starting anything (checklist U2 checks it again per
  source, but get the owner's answer up front — "which timezone does your Shopify admin show?").

## 2. Shopify

**Method pending** (see `docs/shopify-connection-method.md`). Recommended: **Option A** (OAuth
install of bcns's Dev Dashboard app via a custom distribution link). Fallback: **Option B**
(client-credentials app in SB's own org). Checklist **S1 no longer checks the token prefix** — the
scope query decides S1/S2 on its own, so a token from either method is accepted whatever it starts
with.

### 2.1 What Declan sends

| Option A (recommended) | Option B (fallback) |
|---|---|
| Declan (or whoever has app-install permission on `saunaboy-2`) opens the custom distribution link bcns generates and approves the scopes. Declan sends nothing — Nate exchanges the OAuth `code` for the token himself. | Declan creates an app in SB's own Dev Dashboard, sets scopes, installs it, and sends the **client ID + client secret**. |
| Scopes (least privilege, from DESIGN §4.2): `read_orders, read_all_orders, read_products, read_inventory, read_shopify_payments_payouts, read_reports, read_customers`. | Same scopes, set on the app version in SB's org. |
| Also confirm: which store is live (`saunaboy-2` is Basic, 0 orders, password-protected as of 2026-09-12). | Token expires in 24h — needs a refresh path not built yet (see method doc). |

### 2.2 Checklist items that can fail

| id | means | fix |
|---|---|---|
| S1 | missing scopes, or the token can't query the Admin API at all | confirm scopes on the app match §4.2, and that the token was installed on the live store |
| S2 | `read_all_orders` not granted | re-grant the scope on the app, reinstall |
| S3 | (informational — currency always set from `shop{currencyCode}`) | n/a, not a failure path |
| S4 | (informational — sets `sessions_mode`, never throws) | n/a |
| S5 | (informational — sets `store_timezone`; a mismatch is a **warning**, not a failure) | if warned, resolve via U2 |

### 2.3 Exact command + prompts

```
corepack pnpm tsx scripts/add-source.ts --slug sb --source shopify
```
Prompts, in order:
1. `shopify shop:` → the `*.myshopify.com` subdomain, e.g. `saunaboy-2`
2. `shopify admin_url:` → `https://admin.shopify.com/store/saunaboy-2`
3. `shopify Admin API token:` → the token from step 2.1 (any prefix; S1 checks scopes, not the prefix)

### 2.4 Confirm first pull

```sql
select status, last_run_at, last_success_at, last_error
from api.connector_health_v1
where client_id = (select id from data.clients where slug = 'sb') and source = 'shopify';

select count(*) from data.raw
where client_id = (select id from data.clients where slug = 'sb') and source = 'shopify';

select count(*) from data.money
where client_id = (select id from data.clients where slug = 'sb') and source = 'shopify';
select count(*) from api.money_v1
where client_id = (select id from data.clients where slug = 'sb') and source = 'shopify';

select count(*) from data.products
where client_id = (select id from data.clients where slug = 'sb') and source = 'shopify';
select count(*) from api.products_v1
where client_id = (select id from data.clients where slug = 'sb') and source = 'shopify';
```
`api.*_v1` views are `security_invoker`; as `postgres` they read every client, so always filter by
`client_id`.

## 3. Meta Ads

### 3.1 What Declan sends

- A Business Manager **system user token** (not a personal user token — checklist M1 fails on
  `USER` type). Declan mints it in Business Settings → Users → System Users, least privilege:
  grant only `ads_read` on SB's ad account.
- `act_id` — the ad account id (from Ads Manager URL, `act=<digits>` — send with or without the
  `act_` prefix, config stores `act_<id>`).
- The Ads Manager URL for that account, e.g.
  `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123`.

### 3.2 Checklist items that can fail

| id | means | fix |
|---|---|---|
| M1 | `/debug_token` reports a type other than `SYSTEM_USER` | Declan re-mints as a system user token, not a personal token |
| M2 | system user can't read `act_<id>` (no `ads_read`, or wrong id) | grant `ads_read` on the account to the system user; double-check the id |
| M3 | account `timezone_name` ≠ `clients.timezone` | **warning only, does not fail.** Resolve via U2 — record which timezone SB confirmed in `clients.notes` |

### 3.3 Exact command + prompts

```
corepack pnpm tsx scripts/add-source.ts --slug sb --source meta
```
Prompts, in order:
1. `meta act_id:` → e.g. `act_123`
2. `meta ads_manager_url:` → the URL from 3.1
3. `meta system user token:` → the token from 3.1

### 3.4 Confirm first pull

```sql
select status, last_run_at, last_success_at, last_error
from api.connector_health_v1
where client_id = (select id from data.clients where slug = 'sb') and source = 'meta';

select count(*) from data.raw
where client_id = (select id from data.clients where slug = 'sb') and source = 'meta';

select count(*) from data.daily_metrics
where client_id = (select id from data.clients where slug = 'sb') and source = 'meta';
select count(*) from api.campaign_daily_v1
where client_id = (select id from data.clients where slug = 'sb');
```
(`campaign_daily_v1` has no `source` column — it's meta-only by construction, still filter by
`client_id`.)

## 4. Monday.com

### 4.1 What Declan sends

- A **personal API token** (Monday: Avatar → Admin → API, or Profile → Developers). No scoping
  granularity below "whatever that user can see" — least privilege means using a token from a
  read-only/limited board member, not an admin, if SB can create one.
- The board id and board URL, e.g. `https://<acct>.monday.com/boards/18410184464`.

### 4.2 Checklist items that can fail

| id | means | fix |
|---|---|---|
| D1 | no `Status` column found on the board (by title `Status` or by type `status`) | ask Declan to add/rename a Status column, or point at a different board |

Other columns (`due`, `owner`, `priority`, `link`) are autodetected by type/title and are optional
— missing ones just leave that field null in `jobs`.

### 4.3 Exact command + prompts

```
corepack pnpm tsx scripts/add-source.ts --slug sb --source monday
```
Prompts, in order:
1. `monday board_id:` → e.g. `18410184464`
2. `monday board_url:` → the URL from 4.1
3. `monday personal token:` → the token from 4.1

### 4.4 Confirm first pull

```sql
select status, last_run_at, last_success_at, last_error
from api.connector_health_v1
where client_id = (select id from data.clients where slug = 'sb') and source = 'monday';

select count(*) from data.raw
where client_id = (select id from data.clients where slug = 'sb') and source = 'monday';

select count(*) from data.jobs
where client_id = (select id from data.clients where slug = 'sb') and source = 'monday';
select count(*) from api.jobs_v1
where client_id = (select id from data.clients where slug = 'sb') and source = 'monday';
```

## 5. Google Meet notes (provisional connector — see DESIGN §4.5)

### 5.1 What Declan sends

- A Google OAuth app registered **inside SB's own Workspace**, user type **Internal** (checklist
  G1 fails a bcns-org client id). Someone at SB (or a role account) consents once.
- `oauth_client_id` and `oauth_client_secret` for that app.
- A **refresh token** minted from that consent, scope `drive.readonly` only (least privilege — no
  write scope needed, the connector only reads).
- The Drive **folder id** holding the Gemini notes docs (the id segment of the folder URL) and the
  folder URL itself.

### 5.2 Checklist items that can fail

| id | means | fix |
|---|---|---|
| G1 | OAuth client is bcns's own (`BCNS_OAUTH_CLIENT_ID` env match), or refresh fails, or token audience ≠ `oauth_client_id` | app must live in SB's Workspace project, not ours; re-consent if `invalid_grant` |
| G2 | no readable Gemini notes doc in the folder | confirm the folder id, and that the token's scope/consent actually covers that folder |

### 5.3 Exact command + prompts

```
corepack pnpm tsx scripts/add-source.ts --slug sb --source meet
```
Prompts, in order:
1. `meet folder_id:` → Drive folder id of the Gemini notes
2. `meet oauth_client_id:`
3. `meet notes_url:` → `https://drive.google.com/drive/folders/<id>`
4. `meet access token (blank to mint from refresh):` → leave blank, let it mint from the refresh token
5. `meet refresh token:`
6. `meet oauth_client_secret:`

### 5.4 Confirm first pull

```sql
select status, last_run_at, last_success_at, last_error
from api.connector_health_v1
where client_id = (select id from data.clients where slug = 'sb') and source = 'meet';

select count(*) from data.raw
where client_id = (select id from data.clients where slug = 'sb') and source = 'meet';

select count(*) from data.messages
where client_id = (select id from data.clients where slug = 'sb') and source = 'meet';
select count(*) from api.messages_v1
where client_id = (select id from data.clients where slug = 'sb') and source = 'meet';
```

## 6. Google Drive content library

### 6.1 What Declan sends

- Same OAuth app as Meet (DESIGN §4.6), but a **separate refresh token** — mint a second consent
  on the same app so the `meet` and `drive` token rows never share one.
- `oauth_client_id` (same app id as Meet) and `oauth_client_secret`.
- The Drive **folder id** of the marketing/content library folder (flat folder only — no
  subfolders indexed).

### 6.2 Checklist items that can fail

| id | means | fix |
|---|---|---|
| G1 | same as Meet — wrong OAuth client, refresh fails, or audience mismatch | same fix as 5.2 |
| G2 | no readable file in the Drive folder | confirm folder id and that the token's consent covers it |

### 6.3 Exact command + prompts

```
corepack pnpm tsx scripts/add-source.ts --slug sb --source drive
```
Prompts, in order:
1. `drive folder_id:` → content library folder id
2. `drive oauth_client_id:`
3. `drive access token (blank to mint from refresh):` → leave blank
4. `drive refresh token:` → the second, separate refresh token from 6.1
5. `drive oauth_client_secret:`

### 6.4 Confirm first pull

```sql
select status, last_run_at, last_success_at, last_error
from api.connector_health_v1
where client_id = (select id from data.clients where slug = 'sb') and source = 'drive';

select count(*) from data.raw
where client_id = (select id from data.clients where slug = 'sb') and source = 'drive';

select count(*) from data.media
where client_id = (select id from data.clients where slug = 'sb') and source = 'drive';
select count(*) from api.media_v1
where client_id = (select id from data.clients where slug = 'sb') and source = 'drive';
```

## 7. Failure + rotation

- **Re-running `add-source` is always safe.** It rotates the token (new `secret`/`refresh_secret`),
  resets `source_tokens.status` to `active`, and keeps `connector_schedule`'s cursors and
  `next_run_at` — nothing re-backfills from scratch.
- **`a <source> run for sb is in flight`**: a worker run holds the lease with the old token; a 401
  from it would mark the new token `auth_failed`. Wait a few minutes (leases last ≤ 8 min) and re-run.
- **`<board_id|shop|act_id|folder_id> changed (...)`**: the new answer points at a different
  board/store/account/folder than the saved schedule, whose cursors belong to the old one. If the
  change is intended, re-run with `--reset-cursors` — it re-backfills the new target from
  `backfill_from` and pulls on the next tick.
- **`source_tokens.status = 'auth_failed'`**: the worker sets this when a live pull's auth call
  fails (distinct from the onboarding checklist, which fails before any write). Check:
  ```sql
  select source, status, status_detail
  from data.source_tokens
  where client_id = (select id from data.clients where slug = 'sb');
  ```
  Fix by getting a fresh credential from Declan and re-running the same `add-source` command for
  that source — it upserts on `(client_id, source)` and clears `status`/`status_detail`.
- **U2 timezone mismatch**: S5/M3 print a warning (not a failure) when the source's own timezone
  disagrees with `clients.timezone`. When that happens, confirm with Declan which timezone is
  correct and record the decision:
  ```sql
  update data.clients set notes = coalesce(notes || E'\n', '') || '<decision, e.g. "confirmed America/New_York with Declan 2026-09-xx">'
  where slug = 'sb';
  ```
  (`clients.timezone` itself only changes if the owner says the *stored* timezone is wrong —
  changing it also triggers a renormalize on every connector, DESIGN §1.2.)
