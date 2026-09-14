# Engineer Report
**Task:** Item A4 — shop handle normalization, drive test Storage cleanup, checklist S1 without the `shpat_` prefix
**Branch:** fix/connection-small-fixes (PR https://github.com/bcn-services/bcns-data/pull/8, draft)
**Date:** 2026-09-13

## Design Decisions
- One `shopHandle`/`shopifyEndpoint` pair exported from `worker/src/connectors/shopify.ts` rather than a normalizer per call site — the connector already owned the dotted-value tolerance, so no new module.
- Fixed the third URL builder too: `worker/src/tokens.ts:30` built `https://${shop}/admin/api/...` and was broken for a bare handle; patching only the two named files would have left that sibling caller wrong.
- `scripts/onboard.ts` still stores the operator's raw `shop`; both readers normalize, so no migration and no change to the asserted stored config.
- `shopHandle` takes the first label as the handle, matching `adminUrl`'s pre-existing assumption. A custom-domain-only store would need a different rule; the Admin API does not support that today.
- S1's prefix throw removed rather than softened to a warning — the scope query is a strictly stronger check and already distinguishes S1 from S2.
- Storage cleanup queries `storage.objects` for the fixture prefixes and removes via the service client, then re-lists and throws — a future leak fails the suite instead of accumulating.
- The (c) test coverage went into the two existing Shopify cases (injected `fetch`, captured token + URL) instead of a new `it`, so it also pins the (a) normalizer in the same assertion.
- DESIGN.md left unedited: outside the named scope, concurrently touched by other worktrees in this window, and the §9 contract deserves its own review. Flagged in the PR.

## Files Changed
- `worker/src/connectors/shopify.ts` — added exported `shopHandle` + `shopifyEndpoint`; `adminUrl` and `gql` now use them.
- `worker/src/tokens.ts` — §5.4 Shopify auth probe uses `shopifyEndpoint`, fixing a bare-handle URL.
- `scripts/checklist.ts` — dropped the `shpat_` throw; builds the URL with `shopifyEndpoint`.
- `scripts/onboard.ts` — Shopify secret prompt label no longer claims a `shpat_…` prefix.
- `test/drive-tombstone.test.ts` — `afterAll` removes every Storage object under each fixture prefix and asserts the prefix is then empty.
- `test/scripts.test.ts` — hoisted `shopifyScopes(scopes?)`; checklist test asserts a prefix-less token reaches the scope query at the normalized URL; add-source refusal case now fails on missing scopes via a `no-scopes` sentinel token.
- `docs/connection-day.md` — §2 method note, S1 failure-table row, and prompt transcript no longer require a prefix.
- `docs/shopify-connection-method.md` — open item 3 marked RESOLVED, history kept, redaction noted as retained.

## Deferred / Out of Scope
- `DESIGN.md:794` and `:1299` still describe the Admin API token as `shpat_`; `:1299` is now stale as a requirement. One-line follow-up.
- `pnpm-workspace.yaml`'s `allowBuilds:` block (written by `pnpm install`) reverted and uncommitted per instruction; every later `pnpm` call reprompts a modules reinstall. Someone should decide whether it belongs in the committed file.
- An `orig/` object an upload test leaves under the live seeded acme client — that test's scope, not this item's.

## Flags for Reviewer
- `scripts/checklist.ts` now imports `worker/src/connectors/shopify.js` at runtime (previously a type-only import of `index.js`), pulling the connector registry and zod into the checklist path. `onboard.ts`/`add-source.ts` already import the registry, so no practical change — but it is a new runtime edge in a cycle (`index` ↔ `shopify`).
- S1 is now one unauthenticated-to-us network call away from its verdict: a Shopify outage returning a 200 with an empty body yields "S2: missing scopes", not "the API is down". Same as before for every other item, but the prefix check used to catch garbage offline.
- `afterAll` removes by prefix match on `split_part(name,'/',1)`; it is scoped to the UUIDs this suite created, but it is a Storage delete driven by a DB query — worth a second look that `made` can never contain a non-fixture id.
- The drive test's Storage delete runs before the row deletes; a failure there now aborts cleanup and leaves rows behind (loud, by design).
