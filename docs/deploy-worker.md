# Deploying the worker (first time)

The worker is a Cloud Run Job, `bcns-data-worker`, in the existing bcns GCP project, kicked every
5 minutes by Cloud Scheduler `bcns-data-tick`, which calls it as its own `bcns-data-tick` service
account (DESIGN §5.1). `.github/workflows/deploy-worker.yml` builds the image and runs `gcloud run
jobs update` on every push to `main` that touches `worker/`, `package.json` or `pnpm-lock.yaml` —
so **the job, the registry, the secrets and the Workload Identity binding have to exist before the
first deploy**. `scripts/gcp-setup.sh` creates them.

All of this is Nate-run, in Nate's own terminal, one step at a time. The script prints the exact
`gcloud` command before each step and does nothing until you answer `y`; answering `n` to
everything runs nothing at all, which is a safe way to read what it would do.

## Morning order

1. **`! gcloud auth login`** — as a principal that can administer IAM, Cloud Run, Artifact
   Registry, Secret Manager and Cloud Scheduler in the project.
2. **Run `scripts/gcp-setup.sh` step by step:**
   ```
   export GCP_PROJECT=<project id> GCP_REGION=<region>          # region default: us-east4
   export SUPABASE_URL=https://<ref>.supabase.co BCNS_ALERT_EMAIL=<alerts inbox>
   bash scripts/gcp-setup.sh
   ```
   `us-east4` is the default because the Supabase project sits in AWS `us-east-1`. The two
   Supabase/alert values go into the job's env, so they come from the environment rather than a
   prompt — step 6 refuses to create the job while either is unset. The script also prompts once,
   up front, for `BCNS_ALERT_FROM` (default `bot@bcn-services.com`): it must be a sender already
   **verified in Resend**, because `worker/src/health.ts` otherwise falls back to the alert inbox
   as the `from` address and Resend rejects every send. Step 5 asks for the three secret values at
   a hidden prompt (`DATABASE_URL` — the Supabase **transaction**-mode pooler URL,
   `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`) and pipes each straight into Secret Manager;
   none is echoed or written to disk. Step 7 creates the Scheduler job as the `bcns-data-tick`
   service account, so the principal running the script needs `iam.serviceAccounts.actAs` on it —
   project Owner already has it.
3. **Set the four GitHub settings it prints** (step 8) — `GCP_WORKLOAD_IDENTITY_PROVIDER` and
   `GCP_SERVICE_ACCOUNT` as secrets, `GCP_REGION` and `GCP_PROJECT` as variables, all with
   `GITHUB_TOKEN= gh ...`.
4. **Merging to `main` triggers `deploy-worker`** — it builds `worker/Dockerfile`, pushes
   `${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/bcns/bcns-data-worker:<sha>`, and swaps the
   placeholder image out with `gcloud run jobs update`. `workflow_dispatch` does the same on demand.
5. **The first deploy runs with 0 sources** — the tick claims nothing, housekeeping is a no-op, and
   `tick_done` in the Cloud Run logs is the whole success signal. Nothing pulls until a source is
   attached (`docs/connection-day.md`).

## What the script sets on the job

| | |
|---|---|
| `--set-env-vars` | `SUPABASE_URL`, `BCNS_ALERT_EMAIL`, `BCNS_ALERT_FROM`, `TASK_COUNT` (2 — must match the workflow's `--tasks`, because `tick()` shards claims by `hashtext(client_id) % TASK_COUNT` against `CLOUD_RUN_TASK_INDEX`) |
| `--set-secrets` | `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, each `<name>:latest` |
| unset on purpose | `RUN_BUDGET_MS`, `CLAIM_LIMIT`, `EGRESS_ALLOWANCE_BYTES`, `RENORMALIZE_BUDGET_MS` — the worker's own defaults in `worker/src` are the intended production values. `.env.example` carries the same four, but it is a local-dev file and not authoritative (its `TASK_COUNT=1` is deliberately not the job's 2). Set one with `gcloud run jobs update` if it ever needs to differ. |
| set by Cloud Run | `CLOUD_RUN_TASK_INDEX` |

The workflow only ever touches the image and the task/CPU/memory shape; env and secrets live on the
job, so re-running the setup script is never needed after a code change.

## Afterwards

- Rotate a secret: `gcloud secrets versions add <name> --data-file=-` (the job reads `:latest`).
- Change `TASK_COUNT`: `gcloud run jobs update --set-env-vars TASK_COUNT=<n>` **and** set the
  `TASK_COUNT` repo variable, which `deploy-worker.yml` reads for `--tasks`/`--parallelism` and
  otherwise defaults to 2. The setup script sets neither of these to a repo variable — it only
  sets the job env — so today both sides are 2 by coincidence of matching defaults, and a change
  has to touch both or the shards do not cover every client.
- The deployer SA's write roles are resource-scoped: `artifactregistry.writer` on the `bcns` repo,
  `run.developer` on the `bcns-data-worker` job, `iam.serviceAccountUser` on the runtime SA only.
  Its one project-wide role is `roles/run.viewer`, which is read-only and carries the
  `run.operations.get` that `gcloud run jobs update` needs to poll its update operation.
- No service-account keys exist anywhere; GitHub authenticates by Workload Identity only, and the
  org policy `iam.managed.disableServiceAccountKeyCreation` blocks keys regardless.
