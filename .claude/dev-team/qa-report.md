# QA Report
**Task:** A3 — `position` on `data.media_set_items`: backfill, appending add-path, `api.reorder_media_set_items`, data-client 0.3.0
**Branch:** feat/media-set-position
**Date:** 2026-09-14
**Gate mode:** tests

## VERDICT: PASS

## Criteria Checked
- Migration adds `position integer not null`, backfilled ordered by `added_at` per set — check: re-ran the exact `-- backfill:begin/end` SQL block against a scratch copy of `data.media_set_items` with position nulled; per-set position order matched `added_at` order and was dense from 0 — PASS
- Add-path (`api.set_media_set_items` action=add) appends at `max(position)+1` per set, in `media_ids` order — check: added 2 new ids to a 1-item set in reverse-of-mediaId order, confirmed resulting positions 0,1,2 in `[existing, id3, id2]` order — PASS
- `api.media_set_items_v1` exposes `position` and is ordered by it — check: static (view definition, `contract.json`, `database.types.ts`) plus behavioral: unordered `.select()` on the view after a reorder returned rows in position order — PASS
- New RPC `api.reorder_media_set_items(set_id, media_ids)`: `tenant_or_raise()` → BCNS0 — check: minted an authenticated JWT with no membership row (USERS.nobody), called the RPC, got `BCNS0` — PASS
- `require_w()` (BCNS2) — Not independently verifiable: `data.member_role` is only `{member, owner}` and both hold W; `require_w()` can only fail when `active_client_role()` is null, which `tenant_or_raise()` already turns into BCNS0 one statement earlier. No fixture can reach this path (matches the engineer's own documented reasoning in **Deferred / Out of Scope**). See Not Verifiable.
- Set-ownership check → BCNS4 not_found — check: reordered a set with a foreign-tenant caller not covered below; also directly asserted via mutation 1 (see Mutations) — PASS
- Strict validation: array must be exactly current members (same length, no dup, same ids) else BCNS3 detail `media_ids`, nothing written — check: parametrized test over missing id / extra id / duplicate id / null, each asserted BCNS3 and unchanged rows before/after — PASS
- On success, `position = array index` — check: reordered a 3-item set, asserted view positions equal `[0,1,2]` in the new order — PASS
- data-client `@bcn-services/data-client` 0.2.0 → 0.3.0, catalog entry for new RPC, regenerated types exposing `position`, NOT published — check: `package.json` version is `0.3.0`; `src/index.ts` `RPC_NAMES` includes `reorder_media_set_items`; `database.types.ts` has `position` on `media_set_items_v1` and `Functions.reorder_media_set_items` args/returns; ran the package's own `tsc -p tsconfig.json` build, succeeded with no errors; `git log` on this branch has no publish commit, no `.npmrc`, `git status` shows no registry artefacts — PASS
- Refusal: beta user reordering acme's set → BCNS4 — check: signed in as `betaMember`, called `reorder_media_set_items` on an acme set, asserted BCNS4 and rows unchanged before/after; independently confirmed via mutation 1 (removing the ownership check flips this to BCNS3) — PASS
- Refusal: signed out → BCNS0 — check: minted authenticated JWT with no tenant claim, asserted BCNS0; separately asserted the bare anon key (no session at all) gets `42501`/`BCNS0` and never mutates rows — PASS
- `api/contract.json` updated for the new `position` column — check: diffed against `main`, `media_set_items_v1.position: "integer"` added; covered by existing `test/contract-update.ts`/`catalog.test.ts` in the full suite — PASS
- `supabase/seed.sql` still loads on a fresh reset — check: ran `supabase db reset` five times (baseline + after each of 3 mutations + final) — all succeeded, seed loaded, `media_set_items` rows all have non-null `position` — PASS

## Full Suite
Fresh `supabase db reset`, then `node_modules/.bin/vitest run --reporter=dot`:
**11 test files passed, 101 tests passed, 1 todo (102 total).** (86 pre-existing + 1 todo from the engineer's suite, +15 from my `media-set-position.qa.test.ts`.)
`node_modules/.bin/tsc --noEmit -p tsconfig.json` — clean, no errors.
`packages/data-client`: `../../node_modules/.bin/tsc -p tsconfig.json` — clean build, `dist/` produced with `position` present in `database.types.d.ts`.

## Mutation Checks
All three restored via `cp` from a saved original + `git status` confirmed clean, followed by a fresh `supabase db reset` before the next mutation and after the last.

1. **Removed the set-ownership `if not exists` block** from `api.reorder_media_set_items`. Re-ran `beta member reordering acme set -> BCNS4, nothing changes`:
   `AssertionError: expected 'BCNS3' to be 'BCNS4'` — test correctly went red (the strict-validation branch now fires instead, since beta's own membership doesn't match acme's member count/ids — still a real block, but the intended BCNS4 detection failed as designed). **Confirmed.**

2. **Removed the duplicate-id `exists (... having count(*) > 1)` clause**. Re-ran `strict validation: duplicate id -> BCNS3, nothing written`: **stayed green** — `1 passed`.
   Root cause (not a test defect): with array length pinned to equal the member count by the preceding length check, a duplicate value can never leave every existing member covered — pigeonhole forces at least one real member to be absent from a duplicated array of the same length, which the "existing member not covered" `exists` clause already catches independently. I verified this is a structural property, not specific to my fixture (`members={A,B}`, any same-length array containing a dup of one of them necessarily omits the other). **Finding:** the duplicate-id clause is logically redundant given the length + coverage clauses — it can never be the sole reason a request is rejected, so no test (mine or any other) can distinguish its presence from its absence. Classified **design-level** (dead validation branch, harmless defense-in-depth, not a correctness bug) — see Failures.

3. **Changed the view's `order by client_id, set_id, position` to `order by client_id, set_id, added_at desc`**. Re-ran `view is ordered by position, not insertion/added_at order` (rewritten mid-run to drop an incidental explicit `.order('position')` on the PostgREST query that was masking the view's own order — see Tests Added): `AssertionError: expected [...] to deeply equal [...]` (added_at-desc order returned instead of position order). **Confirmed.**

## Failures
- Mutation 2 (duplicate-id clause) is provably dead code given the current length + coverage checks — Root Cause: design-level (redundant guard, not a functional bug; every case it would catch is already caught by the other two clauses). This does not affect the PASS verdict since it doesn't violate any `done when:` criterion — the RPC still rejects duplicates correctly via the coverage check — but it means the item's "duplicate-id clause" cannot be regression-tested in isolation, ever, without changing the other clauses.

## Tests Added
- `test/media-set-position.qa.test.ts` — new file, 15 tests: backfill-block re-run against a scratch table; add-path append order; add-path re-add-existing-member gap behavior (documented finding below); reorder happy path; view-order-not-added_at-order (uses no explicit `.order()` so it actually exercises the view's own `ORDER BY`); 4 strict-validation cases (missing/extra/duplicate/null) each asserting BCNS3 + unchanged rows; beta-on-acme BCNS4 + unchanged rows; signed-out (minted JWT, no membership) BCNS0; anon-key 42501/BCNS0 + unchanged rows; `pg_proc.proconfig` search_path check for both functions; `pg_proc.proacl` role-list parity between `reorder_media_set_items` and `set_media_set_items`; seed.sql sanity (no null positions after reset). No new test infra — reused `test/helpers.ts` (`sql`, `signIn`, `mintJwt`, `clientWithToken`, `USERS`, `CLIENTS`, `mediaId`, `anonClient`) and the existing vitest/pg-pool conventions.

## Not Verifiable
- **BCNS2 (`require_w()`)** for this RPC: not independently reachable by any fixture. `data.member_role` has only `{member, owner}`, both hold write access, so `require_w()` can only raise when there is no active client role at all — a state `tenant_or_raise()` already converts to BCNS0 one line earlier in the same function. Interpretation tested: confirmed via code reading of `data.require_w()`'s call site ordering (same reasoning the engineer documented in their **Deferred / Out of Scope** section); no contradicting fixture exists in the current schema (`data.member_role` enum has exactly 2 values, both `w = true`).
- Everything else: none.
