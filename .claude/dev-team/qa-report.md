---
# QA Report
**Task:** Item A4 — "SB Window A" run: normalize Shopify shop-handle/endpoint parsing, drop the `shpat_` token-prefix requirement from checklist S1, and fix Storage tombstone cleanup in drive fixtures.
**Branch:** fix/connection-small-fixes
**Date:** 2026-09-13
**Gate mode:** tests

## VERDICT: PASS

## Criteria Checked
- `shopHandle`/`shopifyEndpoint` normalize `foo`, `foo.myshopify.com`, `https://foo.myshopify.com/`, trailing slash, uppercase, whitespace, and path-suffix variants to the same endpoint — `test/qa-shopify-handle.test.ts` — PASS
- `worker/src/tokens.ts` §5.4 probe uses the same `shopifyEndpoint` helper (bare vs full-URL shop configs both normalize to the same probe URL, token flips to `active`) — `test/qa-tokens-probe.test.ts` — PASS
- `test/drive-tombstone.test.ts` leaves no Storage object under fixture client prefixes in bucket `media` after its suite — `test/qa-drive-storage-cleanup.test.ts` (runs the real file as a subprocess, then independently queries `storage.objects` for orphans under the fixture prefix; second test proves the removal query pattern itself is sound) — PASS
- Checklist S1 no longer requires the `shpat_` prefix; a prefix-less token reaches the GraphQL scope query — `test/qa-checklist-s1.test.ts` — PASS
- Scope-missing tokens still fail S1 (non-`read_all_orders` missing) / S2 (`read_all_orders` missing) correctly, independent of prefix — `test/qa-checklist-s1.test.ts` — PASS
- `grep -rn shpat_ --exclude-dir=node_modules --exclude-dir=.claude .` reviewed per hit — see Findings below — PASS (no unaddressed stale production logic; two known-stale docs findings reported)
- Full regression green, typecheck clean, `git status` clean apart from test files — `corepack pnpm test` (96 passed / 1 todo), `corepack pnpm typecheck` (clean), `git status --short` shows only the 5 new QA test files — PASS

## Mutation Checks
- (a) `worker/src/connectors/shopify.ts`: `shopHandle` mutated to return input unchanged (`String(shop ?? '')` only). Backed up via `cp` first, shasum before `8bd6a937442013de9be55cf380c0d80c326b0cf6`. Re-ran `test/qa-shopify-handle.test.ts` → failed as expected on `"normalizes a full https URL with trailing slash and path suffix to the same endpoint"` (expected endpoint host `foo`, got `https://foo.myshopify.com/admin/...`-shaped garbage). Restored from `cp` backup (not `git checkout --`); shasum after matched `8bd6a937442013de9be55cf380c0d80c326b0cf6` — byte-identical.
- (b) `test/drive-tombstone.test.ts`: removed the `afterAll` Storage-removal block (left only the row deletes). Backed up via `cp`, shasum before `7ac3bbc9d3ebcf28403f5151f7bb3ce6ca7cc8de`. Ran `test/qa-drive-storage-cleanup.test.ts` → failed as expected on `"leaves no Storage object under the fixture client's prefix after the suite finishes"` (found 1 orphaned object, `<clientId>/thumb/f1.jpg`). Restored from `cp` backup; shasum after matched `7ac3bbc9d3ebcf28403f5151f7bb3ce6ca7cc8de` — byte-identical. Orphaned object cleared via `supabase db reset` before the final regression sweep.
- (c) `scripts/checklist.ts`: reinstated the old `if (!c.secret.startsWith('shpat_')) throw ...` guard ahead of the scope query. Backed up via `cp`, shasum before `3b3fcccb22a0b5556e7f6aacc0c40becd6166dbe`. Ran `test/qa-checklist-s1.test.ts` → failed as expected on `"a token with no shpat_ prefix reaches the scope query and passes when every scope is present"` (rejected with the reinstated `shpat_` error instead of resolving; `reachedScopeQuery` stayed `false`). Restored from `cp` backup; shasum after matched `3b3fcccb22a0b5556e7f6aacc0c40becd6166dbe` — byte-identical.

## Findings
- `worker/src/connectors/shopify.ts` and `scripts/checklist.ts` — Root Cause: **bug** (not gating this verdict). `scripts/checklist.ts` now imports `worker/src/connectors/shopify.js` at runtime (previously type-only). That module is part of a genuine ESM circular dependency with `connectors/index.ts`; it only initializes safely when `index.ts` is evaluated first. Every current real caller (`onboard.ts`, `add-source.ts`) happens to import `connectors/index.js` before `checklist.js`/`shopify.js`, so today's callers are unaffected — but `scripts/checklist.ts` does not itself import `connectors/index.js` at runtime (only as a `type` import), so any future caller or a direct `tsx scripts/checklist.ts` invocation that reaches `checklist.js` first will crash at import time (`ReferenceError: Cannot access 'shopify' before initialization` / `TypeError: reading 'defaults'`). Reproduced in `test/qa-checklist-import-cycle.test.ts` via fresh-process subprocess imports, including confirmation that importing `connectors/index.ts` first avoids it. Suggested fix: add a real (non-type-only) `import '../worker/src/connectors/index.js'` at the top of `scripts/checklist.ts`, or break the cycle in `shopify.ts`/`connectors/index.ts` directly.
- `DESIGN.md:794` — Root Cause: **design-level doc staleness**. Still documents the `shpat_` prefix as a checklist requirement; no longer matches `scripts/checklist.ts`'s scope-only S1/S2 logic. Stale, needs an update pass (not an engineering fix).
- `DESIGN.md:1299` — Root Cause: **design-level doc staleness**. Same stale `shpat_`-prefix requirement language as above.
- `DESIGN.md:1054` — reviewed, not a finding: describes the redaction pattern (`shpat_***`) used for logging, which still matches `worker/src/connectors/index.ts:119`'s actual redaction regex. Accurate as written.
- `worker/src/connectors/index.ts:119` — reviewed, not a finding: intentional token-redaction regex (`.replace(/shpat_\w+/g, 'shpat_***')`) for log safety; unrelated to the prefix-requirement removal.
- `test/scripts.test.ts:282,367-369` — reviewed, not a finding: engineer's own existing fixture literals (e.g. `'shpat_test'`), still valid as arbitrary test data since S1/S2 no longer inspects the prefix.
- `docs/shopify-connection-method.md:8,94,96` — reviewed, not a finding: already correctly updated by the engineer to describe both connection methods minting tokens with no documented prefix.
- My own `test/qa-checklist-s1.test.ts` hits — not a finding: QA test code, arbitrary literal used to prove prefix-independence.

## Tests Added
- `test/qa-shopify-handle.test.ts` — unit tests for `shopHandle`/`shopifyEndpoint` normalization edge cases (bare handle, full URL, trailing slash, uppercase, whitespace, path suffix) plus a mutation-guard assertion.
- `test/qa-tokens-probe.test.ts` — DB-backed integration test exercising `probeAuthFailed` in `worker/src/tokens.ts`, confirming the §5.4 probe uses the same normalized endpoint for a bare handle and a full-URL shop config.
- `test/qa-checklist-s1.test.ts` — tests `checklist('shopify', ...)` S1/S2 scope logic with a prefix-less token: passes when all scopes present, fails S1/S2 correctly by scope alone.
- `test/qa-drive-storage-cleanup.test.ts` — runs the real `test/drive-tombstone.test.ts` as a subprocess, then independently queries `storage.objects` for any orphaned object under the fixture client prefix; a second self-contained test proves the removal/verification query pattern is correct on its own.
- `test/qa-checklist-import-cycle.test.ts` — new minimal test infra (fresh-subprocess module-graph probes via `tsx`) documenting the circular-import fragility finding above; not required by a `done when:` criterion but supports the criterion-3 grep review.

## Not Verifiable
none
---
