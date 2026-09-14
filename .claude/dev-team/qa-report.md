# QA Report
**Task:** A1 — pin `search_path = ''` on the nine `data.*` functions flagged by hosted advisor lint 0011, plus a test mirroring lint 0011
**Branch:** chore/pin-search-path
**Date:** 2026-09-14
**Gate mode:** tests

## VERDICT: PASS

## Criteria Checked
- One migration pins `search_path = ''` on exactly the 9 named functions — `SELECT proconfig FROM pg_proc` after `supabase db reset` shows `search_path=""` on all 9 (`touch_updated_at`, `clients_timezone_valid`, `clients_status_changed`, `clients_timezone_changed`, `ensure_raw_partitions`, `local_day`, `jwt_client_id`, `jwt_client_role`, `clean_tags`) — PASS
- Bodies schema-qualified / no signature or attribute drift from `create or replace` — compared `pg_get_function_identity_arguments`, `pg_get_function_result`, `pronamespace`/`prolang`, `provolatile`, `prosecdef` for all 9 against the values declared in `20260912000100_schema.sql`, `_000200_access.sql`, `_000500_api_rpcs.sql` — identical (all invoker, matching language/volatility/args/return) — PASS
- A test mirroring lint 0011 exists (`function_search_path_pinned` in `test/catalog.test.ts`) and my own independent version (`all 9 target functions are pinned...` in `test/pin-search-path.qa.test.ts`) both assert every function in schemas `data` and `api` carries a `search_path=` pin, with zero unpinned — PASS
- Behavior under the pinned path — exercised each function through its real entry point:
  - `clients_timezone_valid`: inserted a client with timezone `'Not/AZone'` → rejected; inserted with `'America/Chicago'` → accepted — PASS
  - `clients_status_changed`: updated `status='churned'` → `churned_at` stamped; unrelated update after → `churned_at` unchanged — PASS
  - `clients_timezone_changed`: inserted a `connector_schedule` row, changed the client's timezone → `renormalize_requested_at` set — PASS
  - `ensure_raw_partitions`: called directly → the 3 expected `data.raw_YYYY_MM` partitions exist in `pg_class` — PASS
  - `local_day`: called directly with a sample timestamp/client → returns a date — PASS
  - `clean_tags`: called with mixed-case/whitespace/dup tags → lowercased+trimmed+deduped; called with an invalid tag → raises — PASS
  - `jwt_client_id`: signed in as `USERS.acmeMember`, called `api.report_dashboard_version` (chain: `tenant_or_raise → active_client_id → jwt_client_id`) → succeeded, row written for the correct `client_id` — PASS
  - `jwt_client_role`: same signed-in user, called `api.register_upload` (chain: `require_w → active_client_role → jwt_client_role`) → no "function/relation does not exist" error — PASS
- Regression: full suite green, typecheck clean, `git status` clean apart from the new test file — PASS

## Failures
none

## Mutation Checks
**(a) Removed the pin from one function.** Backed up the migration (`cp` to `/tmp/pin_search_path.sql.bak`), edited `data.touch_updated_at()` to drop `set search_path = ''`, ran `supabase db reset`, re-ran the criterion-1 test:
- Assertion that went red: `test/pin-search-path.qa.test.ts > all 9 target functions are pinned... > expect(unpinned).toEqual([])` — failed with `AssertionError: expected [ 'data.touch_updated_at' ] to deeply equal []`.
- Restored the file from the backup; `shasum -a 256` confirmed byte-identical (`c9dcbc5a...618137` before and after); ran `supabase db reset` again to restore a clean stack.

**(b) Scratch SQL, unqualified reference under the pin.** In a scratch `psql` session (not a file), ran `create or replace function data.local_day(...) ... set search_path = '' as $$ select ... from clients ...` (bare, unqualified `clients` instead of `data.clients`). The `CREATE OR REPLACE` statement itself failed at creation time: `ERROR: relation "clients" does not exist` (Postgres validates SQL-language function bodies against the function's own `search_path` at parse time when `check_function_bodies` is on, which is the default). Since the `CREATE` never took effect, the original function was left untouched — confirmed via `pg_get_functiondef('data.local_day(timestamptz,uuid)')`, which still shows the qualified `data.clients` body. No restore needed; this demonstrates the pin catches an unqualified reference even before execution, which is a stronger guarantee than an execution-time failure.

## Tests Added
- `test/pin-search-path.qa.test.ts` (new file, 10 tests, independent of the engineer's test) — verifies: (1) all `data`/`api` functions are pinned and the 9 specifically carry `search_path=""`; (2) signature/return type/language/volatility/security-definer for all 9 match the original migrations exactly; (3)-(9) behavioral checks for each of the 9 functions through real triggers, direct calls, and signed-in RPC calls as described above.

## Not Verifiable
none
