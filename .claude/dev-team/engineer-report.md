# Engineer Report
**Task:** A3 — `position` on `data.media_set_items`, appending add-path, `api.reorder_media_set_items`, data-client 0.3.0
**Branch:** feat/media-set-position
**Date:** 2026-09-14

## Design Decisions
- Positions are **0-based and dense per set**, so `position` is literally the `media_ids` array index the dashboard passes to `reorder_media_set_items`.
- Backfill orders by `(added_at, media_id)`: `data.media_set_items` has no `id` column (PK is `(client_id, set_id, media_id)`), so `media_id` is the tie-break the item's "then id" asks for.
- `unique (set_id, position) deferrable initially deferred` — the reorder renumbers a whole set in one `update`, which transiently collides with itself; deferring keeps the integrity guard without breaking it.
- That constraint forces a **named arbiter** on the add path: bare `on conflict do nothing` fails with `55000` (deferrable constraints cannot be arbiters), and a column-list arbiter re-parses `set_id` as an expression and collides with the plpgsql parameter (`42702`). `on conflict on constraint media_set_items_pkey` avoids both.
- Add-path ordering uses `row_number() over (order by array_position(media_ids, m.id))` so a multi-id add appends in the caller's array order rather than arbitrarily.
- Strict reorder check = same length + no duplicates + every current member present; by pigeonhole that is set equality, so no fourth condition is needed. Reuses `BCNS3` / message `validation` / detail `media_ids`, the same invalid-argument shape `set_media_set_items` uses for `action` and `media_ids`.
- The view is `create or replace` (column appended at the end) rather than drop+create, so its existing grants survive untouched.
- `revoke all ... from public, anon, ...` on the new RPC: the repo-wide revoke lives in an earlier migration, so a newly created function inherits the default `PUBLIC EXECUTE`. `catalog.test.ts > function_privileges` caught this.
- Backfill is testable without leaving a dead one-shot function in `data`: the migration brackets the statement with `-- backfill:begin/end` markers and the test slices and re-runs that exact SQL against scrambled positions.

## Files Changed
- `supabase/migrations/20260914000200_media_set_position.sql` — new: add + backfill + not-null + deferrable unique `position`; replace `api.media_set_items_v1` (exposes `position`, `order by client_id, set_id, position`); replace `api.set_media_set_items` (appending add path); create `api.reorder_media_set_items`; revoke/grant. Both functions carry `security definer set search_path = ''`.
- `supabase/seed.sql` — media-set items now insert an explicit `position` (the column is `not null`) and stagger `added_at` by one second per item, so the backfill's ordering rule is verifiable rather than an all-ties no-op.
- `test/media-set-position.test.ts` — new: backfill order, add-path append order, view exposure + ordering, reorder happy path, five strict-mismatch cases, beta-on-acme `BCNS4`, no-tenant `BCNS0` + anon `42501`.
- `test/helpers.ts` — `RPC_ARGS.reorder_media_set_items` (`expect: 'BCNS4'`) and `betaRpcArgs()` now fills its `set_id`, so `rpc_every_write_scoped` and `no_claim_zero_rows` cover the new RPC.
- `packages/data-client/src/index.ts` — `reorder_media_set_items` added to `RPC_NAMES`.
- `packages/data-client/src/database.types.ts` — regenerated (`media_set_items_v1.position`, `Functions.reorder_media_set_items`).
- `packages/data-client/package.json` — 0.2.0 → 0.3.0. Not published.
- `api/contract.json` — regenerated via `test/contract-update.ts` for the additive `position` column.

## Deferred / Out of Scope
- No hosted `supabase db push`, no `npm/pnpm publish` — both are morning-wizard steps.
- `media_sets_v1.cover_thumb_path` still means "newest member by `added_at`", not "position 0". DESIGN.md §3.2 defines it that way; changing it is a separate decision.
- No `BCNS2` test for the write role: `data.member_role` is only `{member, owner}` and both hold W, so `data.require_w()` raises only when `active_client_role()` is null — which `data.tenant_or_raise()` has already turned into `BCNS0` one line earlier. No fixture can reach it; the item allowed for this ("if such a fixture exists").
- No 500-id cap on `reorder_media_set_items`: the strict check already bounds `media_ids` to the set's member count.

## Flags for Reviewer
- `reorder_media_set_items` runs four scans of `media_set_items` for one set (count, duplicate check, missing-member check, update). Bounded by set size, index-backed by the PK — fine for a Content Library, worth a single CTE if sets ever grow large.
- Concurrent `set_media_set_items(action => 'add')` on the same set can compute the same `max(position)+1`. The deferrable unique turns that into a loud commit-time failure rather than duplicate positions; there is no row lock on the set, so a retry is the caller's job.
- ~~The add path leaves **gaps**~~ — fixed in the QA fix pass: already-members are excluded from the insert by a `not exists` clause, so `row_number()` numbers only genuinely new rows. `on conflict on constraint media_set_items_pkey do nothing` stays for the concurrent case, which is the only path that can still gap.
- `api.media_set_items_v1` now carries `order by`, which PostgREST callers can still override; the sort is backed by the new unique index.
- Backfill is one full-table `update` on `data.media_set_items` at deploy time — trivial today, worth a batched run if that table is ever large.

## QA fix pass (2026-09-14)

QA (Sonnet 5) returned **VERDICT: PASS** at 101 passed / 1 todo, adding 15 tests in
`test/media-set-position.qa.test.ts`. One finding actioned, one accepted as-is.

### Changes
- `supabase/migrations/20260914000200_media_set_position.sql` — the add branch now excludes rows already in the set (`and not exists (select 1 from data.media_set_items i where i.set_id = … and i.media_id = m.id)`) instead of leaving them to `ON CONFLICT`, so `row_number()` numbers only genuinely new rows and new members take contiguous positions after `max(position)`. The named arbiter stays for the concurrent case. Header comment corrected: dense per set, gaps only under a concurrent add.
- `test/media-set-position.test.ts` — new test: re-adding an existing id alongside a new one returns `1` and puts the new id at `max+1` with no gap.
- `test/media-set-position.qa.test.ts` — QA's re-add test observed and logged the position rather than asserting it; tightened to assert `2` and a contiguous `[0, 1, 2]`, and renamed off the "gap or no gap" phrasing.

### Not changed
- The duplicate-id clause in `api.reorder_media_set_items` stays. QA's mutation 2 showed it is unreachable given the length + coverage checks (pigeonhole), but it mirrors the item's spec text and costs nothing.

### Verification
- Mutation check on the fix: restored the pre-fix function body in-DB and re-ran both re-add tests — **2 failed**, `expected 3 to be 2`. Restored by `supabase db reset`.
- Fresh `supabase db reset` → **102 passed / 1 todo** (11 files). `tsc --noEmit -p tsconfig.json` clean.
