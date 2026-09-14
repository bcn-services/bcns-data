# Review report: A2 gcp-setup.sh

**Date:** 2026-09-13 · **Files reviewed:** 8 (+ pnpm-lock.yaml, .env.example, package.json as evidence)
**Dimensions swept:** Efficiency (1) · Reliability (7) · Scalability (clean) · Safety & Security (2) · Fault Tolerance (clean) · Data Integrity (clean) · Over-Engineering (clean)

## 1. Morning path — what fails, in order

**Verified correct (no finding):** the printed provider resource `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github` (gcp-setup.sh:63) is exactly the form `google-github-actions/auth@v2` expects at deploy-worker.yml:21. The `principalSet://.../attribute.repository/bcn-services/bcns-data` form (gcp-setup.sh:62) is correct, and `roles/iam.workloadIdentityUser` on the deployer SA (:147) is the right binding for impersonation. `gcloud run jobs update` (deploy-worker.yml:27) is a patch: it passes only `--image` and the same shape flags, so the env, secrets and `--service-account` set at gcp-setup.sh:206-211 survive. `artifactregistry.writer` (:116) covers the push. `gcloud auth configure-docker ${GCP_REGION}-docker.pkg.dev` (deploy-worker.yml:24) matches the push host (:16) and the repo's region (gcp-setup.sh:164-165). The Scheduler URI `https://REGION-run.googleapis.com/v2/projects/P/locations/R/jobs/J:run` (:228) is the documented v2 form and `run.invoker` is bound on the job (:229). Project NUMBER is needed only in PRINCIPAL_SET and PROVIDER_RESOURCE, and both are substituted (:158, :261).

**Actual failures, in order:** (a) step 2 aborts if `cloudresourcemanager.googleapis.com` is not already on → finding 3. (b) step 7 aborts and step 8 never prints, if step 6 was skipped → finding 4. (c) on merge, `docker build` fails before `jobs update` is ever reached → findings 1 and 2.

## Critical

- `worker/Dockerfile:8` — Reliability — `pnpm add tsx@4.20.5` runs at a workspace root (pnpm-workspace.yaml is COPYed at :5), which pnpm refuses with `ERR_PNPM_ADDING_TO_ROOT`; deploy-worker.yml:25 dies before `jobs update`. Fix: replace with `npm i -g tsx@4.20.5` (or `pnpm add -w tsx@4.20.5`).
- `worker/Dockerfile:5,8` — Reliability — pnpm-lock.yaml:49 declares the importer `packages/data-client`, but only the root manifest is copied, so `pnpm install --frozen-lockfile` fails `ERR_PNPM_OUTDATED_LOCKFILE`. `worker/src` imports nothing from that package. Fix: `COPY packages/data-client/package.json ./packages/data-client/` before the RUN.

## Important

- `scripts/gcp-setup.sh:100-104` — Reliability — `cloudresourcemanager.googleapis.com` is not in the enable list, yet :115-118, :132-133 and :67 call `gcloud projects …`; on a project where it is off, step 2 exits non-zero and `set -e` kills the script. Fix: add it to `enable_apis`.
- `scripts/gcp-setup.sh:241` — Reliability (idempotence) — `grant_invoker` runs unconditionally; if step 6 was answered `n` or hit the guard at :217, the job does not exist, gcloud fails and `set -e` aborts before step 8 prints the four GitHub settings. Fix: wrap in `exists gcloud run jobs describe "$JOB" … || { echo '  skipped: create the job first' >&2; }`.
- `scripts/gcp-setup.sh:230,234` — Safety & Security — reusing the runtime SA as Scheduler's OAuth identity means the invoker identity also holds `secretAccessor` on DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY and RESEND_API_KEY (:197-198). Fix: a third SA `bcns-data-tick` with only `run.invoker` on the job.
- `scripts/gcp-setup.sh:116,118` — Safety & Security (least privilege) — `artifactregistry.writer` and `run.developer` at project scope. Fix: `gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location "$REGION"` in step 4 and `gcloud run jobs add-iam-policy-binding "$JOB" --role roles/run.developer` in step 6; both are sufficient for push and for `jobs update`. `iam.serviceAccountUser` scoped to the one runtime SA (:119) is already minimal and should stay.
- `worker/src/health.ts:119` + `docs/deploy-worker.md:44` — Reliability — leaving `BCNS_ALERT_FROM` unset makes Resend's `from` the alert inbox itself; an unverified sender is rejected, so every notification burns `attempts` (health.ts:19, cap 5) and no alert ever lands. Fix: add `BCNS_ALERT_FROM=bot@bcn-services.com` to `job_env` (gcp-setup.sh:204).
- `worker/src/db.ts:24` — Reliability — `DATABASE_URL` falls back to `127.0.0.1:54322` inside the job, so a missing or failed secret mount surfaces as connection-refused noise instead of a config error. Fix: require it when `CLOUD_RUN_TASK_INDEX` is set.

## Minor

- `scripts/gcp-setup.sh:158,261` — Efficiency — `project_number()`'s memo is assigned inside `$( )`, a subshell, so `PROJECT_NUMBER` never persists and step 8 re-runs `projects describe`.
- `scripts/gcp-setup.sh:39,43,191` — Reliability — bare `read` (unlike `ask()` at :88) returns non-zero on EOF and `set -e` aborts; step 5 can die mid-loop with some secrets created and others not. Fix: `read -r X || true` plus the existing emptiness checks.
- `.github/workflows/deploy-worker.yml:27` — Reliability — no `--project`; this depends on `auth@v2` inferring the project from the SA email. Fix: `--project ${{ vars.GCP_PROJECT }}`.
- `scripts/gcp-setup.sh` (step 2) — Reliability — the runtime SA has no `roles/logging.logWriter`. If `tick_done` never appears in Cloud Logging after the first run (docs/deploy-worker.md:35 calls it the whole success signal), this is the first thing to check.
- repo root — Efficiency — no `.dockerignore`, so `docker build … .` ships `.git` and any `node_modules` into the context.

## 2. Job env vs what the script sets — complete, nothing misclassified

| var | read at | required | kind | set? |
|---|---|---|---|---|
| DATABASE_URL | db.ts:24 | yes (bad local default) | secret | ✓ :205 |
| SUPABASE_URL | db.ts:58 | yes (throws) | plain | ✓ :204 |
| SUPABASE_SERVICE_ROLE_KEY | db.ts:58 | yes (throws) | secret | ✓ :205 |
| RESEND_API_KEY | health.ts:109 | yes for alerts | secret | ✓ :205 |
| BCNS_ALERT_EMAIL | health.ts:109 | yes for alerts | plain | ✓ :204 |
| TASK_COUNT | tick.ts:48 | default 2 | plain | ✓ :204 |
| CLOUD_RUN_TASK_INDEX | tick.ts:47 | default 0 | platform | Cloud Run |
| RUN_BUDGET_MS / CLAIM_LIMIT / RENORMALIZE_BUDGET_MS / EGRESS_ALLOWANCE_BYTES | tick.ts:56,57; renormalize.ts:15; health.ts:98 | defaulted | plain | intentionally unset ✓ |
| BCNS_ALERT_FROM | health.ts:119 | defaults to `to` | plain | unset — see Important |

No missing var, no extra var, no secret set as plain env. `SPACES_*` / `EXPORT_ARCHIVE_DIR` belong to `scripts/hard-delete.ts:28`, not the job — correctly absent.

## 4. Script safety

No secret reaches stdout, stderr, a file or history: `show` prints argv only (:75-82), values come from `read -rs` (:191) and go straight into `--data-file=-` (:193-194), then `unset` (:195). No `.env` read, no `set -x`, no temp file. Remaining gaps are the idempotence and `set -e`/`read` items above.

## 5. docs/deploy-worker.md contradictions

- `:53` tells the reader to "set the repo variable" for TASK_COUNT, but step 8 never sets one and deploy-worker.yml:28 only falls back to `2`. The engineer report's "script sets 2 in both" is wrong — both sides are defaults that happen to agree.
- `:44` claims the unset defaults "already match `.env.example`", but `.env.example` has `TASK_COUNT=1` against the job's 2 and the code default of 2 (tick.ts:48). The claim holds for the five vars it names; the wording invites a wrong TASK_COUNT edit.
- `:19` states the region default is `us-central1`, matching gcp-setup.sh:33 — engineer flagged it unverified; wrong choice means recreating registry, job and scheduler.

## STANDARDS.md Updates
none — the spawn prompt forbids editing anything in this worktree beyond this report.
