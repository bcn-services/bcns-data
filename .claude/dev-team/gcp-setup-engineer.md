# Engineer Report
**Task:** Item A2 — scripts/gcp-setup.sh + deploy doc so the first deploy-worker run has a Cloud Run job to update
**Branch:** feat/gcp-setup-script
**Date:** 2026-09-13

## Design Decisions
- Commands are built once as bash arrays, printed with a quoting helper, then run after the `y` — the printed line cannot drift from what executes.
- `describe` existence checks live inside the post-`y` block, so an all-`n` walk issues zero gcloud calls (verified: gcloud is installed and emitted nothing).
- `SUPABASE_URL` / `BCNS_ALERT_EMAIL` come from the environment, not a prompt, because they appear inside the printed `--set-env-vars`; step 6 refuses to create the job while either is unset.
- `PROJECT_NUMBER` is a literal placeholder in the printed commands and is substituted from `gcloud projects describe` only after `y` (steps 3 and 8), so the lookup itself is gated.
- Secret values: `read -rs` piped with `printf '%s'` (no trailing newline, which a pooler URL cannot carry) straight into `--data-file=-`, then `unset`. `secretmanager.secretAccessor` is bound per secret, never project-wide.
- Cloud Scheduler calls as its own `bcns-data-tick` SA holding only `run.invoker` on the one job; the runtime SA (which can read all three secrets) is never the invoker identity.
- Deployer's `artifactregistry.writer` is bound on the `bcns` repo in step 4 and `run.developer` on the `bcns-data-worker` job in step 6, each after its target exists; only `iam.serviceAccountUser` on the runtime SA stays in step 2. No project-level role is granted to any SA.
- Job created with `us-docker.pkg.dev/cloudrun/container/job`; env and secrets are set only here, since the workflow's `jobs update` touches image and shape only.
- No new dependency, so the new-dependency research rule does not apply; gcloud flag shapes taken from the current surface and flagged as unverified against live GCP.

## Files Changed
- `scripts/gcp-setup.sh` — new. Eight print-then-`y/N` steps: APIs, three SAs, WIF pool/provider/binding, Artifact Registry `bcns`, three secrets, Cloud Run job `bcns-data-worker`, Cloud Scheduler `bcns-data-tick`, then the four `GITHUB_TOKEN= gh …` settings.
- `docs/deploy-worker.md` — new. Morning order, the job's env/secret table, what is deliberately left unset, and post-setup rotation notes.

## Deferred / Out of Scope
- `.github/workflows/deploy-worker.yml` untouched — its `jobs update` works once the job exists.
- `docs/connection-day.md` not pointed at the new doc, to avoid conflicting with the `docs/connection-runbook` worktree.
- No shellcheck run: not installed, and the task forbids installing it. `bash -n` is clean.
- Nothing executed against real GCP or hosted Supabase; no suite run (another agent owns the local DB).
- Commit trailers use `Claude Opus 5 (1M context)` per the session's attribution reminder rather than the `Claude Fable 5.1` line in the spawn prompt, since Opus 5 actually authored this.

## Flags for Reviewer
- `TASK_COUNT` appears in two places (a repo variable the workflow reads for `--tasks`, and the job env) and they must stay equal or `hashtext(client_id) % TASK_COUNT` sharding leaves clients unclaimed. The script sets **only the job env** to 2; the workflow falls back to 2 when the repo variable is unset, so today they agree by matching defaults, not because anything sets both.
- Step 5 leaves an existing secret alone. A stale `DATABASE_URL` version would be used silently; rotation is a documented manual `versions add`.
- Region default is `us-east4` (nearest Cloud Run region to the Supabase project's AWS `us-east-1`).
- Step 8's `project_number()` call will abort the script under `set -e` if gcloud is not authenticated; gcloud's own error is the message.

## Fix pass (2026-09-14)
- Region default `us-central1` → `us-east4`; `cloudresourcemanager.googleapis.com` added to step 1; step 7 guarded so an absent job skips it and step 8 still prints; `bcns-data-tick` SA added; repo/job-scoped deployer roles; `BCNS_ALERT_FROM` prompted (default `bot@bcn-services.com`) and set in the job env; `project_number()` memo now a real global; the three bare `read`s fail with a message on EOF; `docs/deploy-worker.md` `TASK_COUNT` and `.env.example` claims corrected.
- Kept `--oauth-service-account-email` on the Scheduler job rather than `--oidc-...`: the target is a `*.googleapis.com` endpoint, which takes an OAuth access token. Accepted by the orchestrator.
- Step 6 also binds project-level `roles/run.viewer` on the deployer SA: `gcloud run jobs update` polls its update operation and `run.operations.get` is only grantable at project scope. Read-only, so every write role the deployer holds stays resource-scoped.
