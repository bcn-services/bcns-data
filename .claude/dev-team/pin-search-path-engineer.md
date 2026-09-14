# Engineer Report
**Task:** A1 — pin `search_path` on the nine `data.*` functions flagged by hosted advisor lint 0011, plus a test mirroring the lint
**Branch:** chore/pin-search-path
**Date:** 2026-09-13

## Design Decisions
- One additive migration re-creating all nine with `create or replace` — keeps each OID, so triggers, grants and dependent RPCs never drop; old migrations stay untouched as instructed.
- Audited every body against an empty `search_path` and found nothing to re-qualify: all non-`pg_catalog` references (`data.clients`, `data.connector_schedule`, `data.raw`, `data.member_role`) were already schema-qualified, and no body calls an extension function, type or operator.
- `gen_random_uuid()` / `uuid-ossp` / `btree_gin` (all in `extensions`) appear only in column defaults and index definitions, which resolve at DDL time and never through a function's `search_path` — no `extensions.` prefix needed.
- Test lives as a new `it()` in the existing `test/catalog.test.ts` rather than a new file: same `describe('catalog')`, same `sql` helper, one more assertion against `pg_proc`.
- Skipped a `do $$ ... raise exception $$` guard inside the migration that would hard-fail on any unpinned function. The test covers the regression, and a migration-time hard-fail could block the hosted `supabase db push` in the morning wizard.

## Files Changed
- `supabase/migrations/20260914000100_pin_search_path.sql` — new; re-creates the nine functions verbatim plus `set search_path = ''`, preserving signature, language, volatility (stable/immutable/volatile) and security (all invoker).
- `test/catalog.test.ts` — new `function_search_path_pinned` test: every function in `data`/`api` must carry a `search_path=` entry in `proconfig`; mirrors advisor lint 0011 so a future unpinned function fails locally.

## Deferred / Out of Scope
- The 14 lint-0029 warnings (`authenticated` can execute the `api.*` SECURITY DEFINER RPCs) — intentional, that is the whole API surface; documented in the PR body, not changed.
- Leaked-password protection is a hosted dashboard toggle on a paid plan; answered in the PR body, nothing to change in code.
- Hosted `supabase db push` left for the morning wizard per the hard limits.

## Flags for Reviewer
- `data.ensure_raw_partitions()` runs `execute format(...)` DDL under an empty `search_path`; every identifier inside is `data.%I`-qualified, and `test/worker.test.ts` exercises two concurrent callers.
- `data.clients_status_changed` / `data.jwt_client_role` compare and cast enum values (`data.client_status`, `data.member_role`); enum operators come from `pg_catalog` (implicitly searched even at `search_path = ''`), so they resolve — confirmed by the green trigger and RPC tests.
- `create or replace` preserves existing ACLs, so the `revoke`/`grant` block in `20260912000200_access.sql` still holds; `catalog.test.ts function_privileges` re-checks it.
