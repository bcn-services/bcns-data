# Shopify connection method for SB — decision memo

Status: **recommendation, Nate decides.** Written 2026-09-12. No code in this PR.

## The problem

The Shopify connector (DESIGN §4.2) and onboarding checklist (§9 S1) assume a merchant-created
custom app with a non-expiring Admin API token (`shpat_…`). That path is closed: Shopify only lets
merchants manage **legacy custom apps created before January 1, 2026**; new custom apps are built in
the Dev Dashboard. SB's store (`saunaboy-2`) is not in the bcns Shopify organization. Two ways remain.

## Option A — OAuth install of our Dev Dashboard app (custom distribution link)

How it works:
1. bcns creates an app for SB in our Dev Dashboard with the §4.2 scopes (`read_orders, read_all_orders,
   read_products, read_inventory, read_shopify_payments_payouts, read_reports, read_customers`).
2. Distribution → Custom distribution → enter SB's `*.myshopify.com` domain → Generate link. The
   link expires after **7 days**.
3. Someone with app-install permission on SB's store opens the link and approves the scopes.
4. Shopify redirects to our `redirect_uri` with `code`, `shop`, `state`, `hmac`. We exchange the code
   once for an **offline** token:
   ```
   curl -sS -X POST "https://<shop>.myshopify.com/admin/oauth/access_token" \
     -H 'Content-Type: application/x-www-form-urlencoded' -H 'Accept: application/json' \
     --data-urlencode "client_id=$SHOPIFY_CLIENT_ID" \
     --data-urlencode "client_secret=$SHOPIFY_CLIENT_SECRET" \
     --data-urlencode "code=<code from the redirect>" \
     --data-urlencode "expiring=0"
   ```
   Response: `access_token`, `scope`. With `expiring=0` there is no `refresh_token`/`expires_in`.
5. `add-source --slug sb --source shopify` stores it exactly like today's token.

Facts that make this fit:
- Custom distribution needs **no app review**.
- Mandatory compliance (GDPR) webhooks are required only for apps listed on the Shopify App Store.
- Expiring offline tokens are required for **public** apps (new public apps since 2026-04-01, all
  public apps by 2027-01-01). Shopify: *"This doesn't apply to custom apps or apps created by
  merchants."* So a custom-distribution app may keep a non-expiring offline token.
- Result: `token_kind = shopify_admin`, no refresh, **no worker or schema change**.

Costs and risks:
- We need a `redirect_uri` that must exactly match one configured on the app. HTTP is allowed only on
  localhost for development; for a real store plan on an HTTPS page we control that just shows the
  query string (or have Nate do the install himself as SB staff so a localhost redirect lands on his
  machine). Either way the exchange is the one `curl` above, done by Nate, never pasted into chat.
- Verify the `hmac` on the redirect (HMAC-SHA256 of the sorted query params with the client secret)
  and our own `state` before exchanging — skipping it is only acceptable because we started the flow
  and exchange within minutes.
- Custom distribution is one store (or one Plus org) per app → one Dev Dashboard app per client. Fine
  until the public app (REQUIREMENTS "Still open") is worth building.
- **Doc ambiguity:** Shopify lists custom distribution as *"Installed on a single Shopify store, on
  multiple stores that belong to the same Plus organization, or on transfer-disabled development
  stores."* One reading limits the single store to dev/Plus stores; SB is on Basic. Settle it by
  generating the link (step 2) — 5 minutes, before anything else.

## Option B — client credentials from an app in SB's own organization

How it works: Declan (or someone we walk through it) creates the app in **SB's** Dev Dashboard, picks
the scopes, releases a version, installs it on `saunaboy-2`, and sends us the client ID + client
secret. We mint tokens ourselves:
```
POST https://<shop>.myshopify.com/admin/oauth/access_token
Content-Type: application/x-www-form-urlencoded
grant_type=client_credentials&client_id=…&client_secret=…
```
- Only works when *"the app and the store belong to the same Shopify organization"* — hence SB's org,
  not ours (`shop_not_permitted` otherwise).
- Every token expires in 24 h (`expires_in` is always 86399); scopes come from the app version, not the
  request.

Costs:
- Worker change: a new `token_kind` (enum migration) and a refresh path in `worker/src/tokens.ts`
  (DESIGN D20 today refreshes only Google), storing the client secret in `source_tokens.attributes`
  like Google's `oauth_client_secret`. Roughly half a day plus tests, and a migration push.
- Declan has to operate a developer dashboard — more setup friction on the client side.
- Blast radius is similar to A: the client secret mints tokens indefinitely until SB rotates it
  (upside: SB controls rotation without us).

## Recommendation

**Option A** — OAuth install of our Dev Dashboard app with a custom distribution link, non-expiring
offline token. It keeps the connector, schema and worker exactly as designed, and Declan's work is
"click a link, approve". **Fallback: Option B** if Shopify refuses to generate a link for a non-Plus
store.

## Open items before connection day

1. **Link check (Nate, 5 min):** create the app, generate a custom distribution link for SB's
   confirmed live store domain. Refused → switch to B. Also confirm with Declan which store is live
   (`saunaboy-2` is Basic, 0 orders, password-protected).
2. **Rehearse on a bcns dev store first:** install the same app on a dev store in our org, run the
   `curl` exchange, and run `add-source` against the local stack with that token.
3. **Checklist S1 prefix — RESOLVED (2026-09-13).** The check was: `scripts/checklist.ts` rejected
   any token not starting `shpat_`, and Shopify does not document the prefix of OAuth offline or
   client-credentials tokens, so S1 could reject a valid token. The prefix check is now dropped —
   S1/S2 are decided by the scope query alone, and the `shpat_` redaction in
   `worker/src/connectors/index.ts` is kept. No prefix constraint remains on either method.
4. **Redirect target:** pick the HTTPS page or the Nate-as-staff localhost install from Option A.

## Sources (checked 2026-09-12)

- Client credentials grant — https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
- Authorization code grant — https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- Offline access tokens (custom-app exemption, `expiring` param) — https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
- Expiring offline tokens required for new public apps (2026-04-01) — https://shopify.dev/changelog/expiring-offline-access-tokens-required-for-public-apps-april-1-2026
- Distribution methods — https://shopify.dev/docs/apps/launch/distribution and https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
- Compliance webhooks (App Store apps only) — https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
- Legacy custom apps (pre-2026-01-01 only) — https://help.shopify.com/en/manual/apps/app-types/custom-apps
