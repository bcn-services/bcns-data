#!/usr/bin/env bash
# One-time GCP setup for the bcns-data worker (DESIGN §5.1): APIs, three service accounts,
# Workload Identity for GitHub Actions, Artifact Registry, Secret Manager, the Cloud Run
# Job, and the Cloud Scheduler tick. Run it once, by hand, before the first deploy-worker
# run. See docs/deploy-worker.md for the morning order.
#
# Assumes:
#   - gcloud is installed and `gcloud auth login` has been run as a principal that can
#     administer IAM, Cloud Run, Artifact Registry, Secret Manager and Cloud Scheduler in
#     GCP_PROJECT, and that the project exists with billing enabled. Step 7 also needs
#     iam.serviceAccounts.actAs on the tick SA — project Owner already has it.
#   - The GitHub repo is bcn-services/bcns-data (that is where deploy-worker.yml lives).
#   - SUPABASE_URL and BCNS_ALERT_EMAIL are exported before step 6. They go into the job's
#     --set-env-vars, and the printed command has to be exactly what runs, so they come
#     from the environment rather than a prompt. BCNS_ALERT_FROM is prompted for with a
#     default. Every other worker env var has a default in worker/src (RUN_BUDGET_MS,
#     CLAIM_LIMIT, EGRESS_ALLOWANCE_BYTES, ...).
#
# Never does:
#   - Runs no gcloud command before you answer y. The `describe` existence checks also run
#     only after a y, so answering n to every step runs nothing at all.
#   - Creates no service-account keys. Nothing here needs one, and the org policy
#     iam.managed.disableServiceAccountKeyCreation blocks them anyway.
#   - Reads no .env file and never echoes, logs or stores a secret value: secrets are read
#     with `read -rs` and piped straight into `gcloud secrets create --data-file=-`.
#   - Sets no GitHub secret or variable. Step 8 prints the four `gh` commands to run.
#   - Builds and pushes no image. deploy-worker.yml does that; step 6 creates the job with
#     Google's placeholder image so the workflow's `jobs update` has a job to update.
#
# Re-runnable: every step creates only what is missing.

set -euo pipefail

REPO=bcn-services/bcns-data
# us-east4 is the Cloud Run region closest to the Supabase project (AWS us-east-1).
REGION_DEFAULT=us-east4
ALERT_FROM_DEFAULT=bot@bcn-services.com

PROJECT="${GCP_PROJECT:-}"
REGION="${GCP_REGION:-}"
ALERT_FROM="${BCNS_ALERT_FROM:-}"
if [[ -z "$PROJECT" ]]; then
  printf 'GCP project id: '
  read -r PROJECT || { echo 'no input: set GCP_PROJECT and re-run' >&2; exit 1; }
fi
if [[ -z "$REGION" ]]; then
  printf 'GCP region [%s]: ' "$REGION_DEFAULT"
  read -r REGION || { echo 'no input: set GCP_REGION and re-run' >&2; exit 1; }
fi
REGION="${REGION:-$REGION_DEFAULT}"
if [[ -z "$ALERT_FROM" ]]; then
  # health.ts falls back to BCNS_ALERT_EMAIL when this is unset, and Resend rejects an
  # unverified sender — every alert would burn an attempt and never land.
  printf 'Resend-verified alert sender [%s]: ' "$ALERT_FROM_DEFAULT"
  read -r ALERT_FROM || { echo 'no input: set BCNS_ALERT_FROM and re-run' >&2; exit 1; }
fi
ALERT_FROM="${ALERT_FROM:-$ALERT_FROM_DEFAULT}"
[[ -n "$PROJECT" ]] || { echo 'GCP_PROJECT is required' >&2; exit 1; }

DEPLOYER="bcns-data-deployer@${PROJECT}.iam.gserviceaccount.com"   # GitHub impersonates this one
RUNTIME="bcns-data-worker@${PROJECT}.iam.gserviceaccount.com"      # the job runs as this one
TICK="bcns-data-tick@${PROJECT}.iam.gserviceaccount.com"           # Cloud Scheduler calls as this one
POOL=github
PROVIDER=github
AR_REPO=bcns
JOB=bcns-data-worker
SCHEDULER_JOB=bcns-data-tick
# Must match deploy-worker.yml's --tasks/--parallelism, because tick() shards claims by
# hashtext(client_id) % TASK_COUNT against CLOUD_RUN_TASK_INDEX (DESIGN §5.1).
TASK_COUNT="${TASK_COUNT:-2}"
SECRET_ENV=(DATABASE_URL SUPABASE_SERVICE_ROLE_KEY RESEND_API_KEY)

# PROJECT_NUMBER is only knowable from gcloud, so the printed commands show it as a
# placeholder and it is looked up after you answer y.
PRINCIPAL_SET="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}"
PROVIDER_RESOURCE="projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
PROJECT_NUMBER=''
# Sets the PROJECT_NUMBER global once. Callers read the global, not a substitution — assigning
# inside $( ) would run in a subshell and the memo would never survive.
project_number() {
  [[ -n "$PROJECT_NUMBER" ]] ||
    PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
}

step() { printf '\n== %s ==\n' "$*"; }
note() { printf '   %s\n' "$*"; }

# Render argv as one copy-pasteable line; quote only the args that need it.
show() {
  local a out=()
  for a in "$@"; do
    [[ "$a" == *[[:space:]\"]* ]] && a="'$a'"
    out+=("$a")
  done
  printf '  %s\n' "${out[*]}"
}

# One y/N per step. Anything but y skips the whole step.
ask() {
  local reply
  printf '  run this step? [y/N] '
  read -r reply || reply=n
  [[ "$reply" == [yY] ]]
}

# A `describe` used as a yes/no test: "not found" is an expected answer, not an error.
exists() { "$@" >/dev/null 2>&1; }

printf 'bcns-data GCP setup — project %s, region %s, repo %s\n' "$PROJECT" "$REGION" "$REPO"
printf 'Nothing runs until you answer y. Answer n to skip a step.\n'

# ---------------------------------------------------------------- 1. APIs
step '1. Enable APIs'
enable_apis=(gcloud services enable
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
  cloudresourcemanager.googleapis.com
  run.googleapis.com artifactregistry.googleapis.com
  cloudscheduler.googleapis.com secretmanager.googleapis.com
  --project "$PROJECT")
show "${enable_apis[@]}"
note 'already-enabled APIs are a no-op.'
note 'cloudresourcemanager is what every `gcloud projects ...` call below goes through.'
if ask; then "${enable_apis[@]}"; fi

# ---------------------------------------------------------------- 2. Service accounts
step '2. Service accounts (least privilege, no keys)'
create_deployer=(gcloud iam service-accounts create bcns-data-deployer --project "$PROJECT"
  --display-name 'bcns-data GitHub Actions deployer')
create_runtime=(gcloud iam service-accounts create bcns-data-worker --project "$PROJECT"
  --display-name 'bcns-data Cloud Run Job runtime')
create_tick=(gcloud iam service-accounts create bcns-data-tick --project "$PROJECT"
  --display-name 'bcns-data Cloud Scheduler invoker')
grant_actas=(gcloud iam service-accounts add-iam-policy-binding "$RUNTIME" --project "$PROJECT"
  --member "serviceAccount:${DEPLOYER}" --role roles/iam.serviceAccountUser)
show "${create_deployer[@]}"
show "${create_runtime[@]}"
show "${create_tick[@]}"
show "${grant_actas[@]}"
note "serviceAccountUser on ${RUNTIME} only: the workflow's \`jobs update\` has to keep the job's"
note '--service-account, which counts as acting as it. No project-wide role is granted here.'
note "the deployer's artifactregistry.writer and run.developer are bound in steps 4 and 6, scoped"
note "to the ${AR_REPO} repo and the ${JOB} job. The runtime SA gets secretmanager.secretAccessor"
note 'in step 5, per secret. The tick SA gets run.invoker on the one job in step 7, nothing else.'
if ask; then
  exists gcloud iam service-accounts describe "$DEPLOYER" --project "$PROJECT" || "${create_deployer[@]}"
  exists gcloud iam service-accounts describe "$RUNTIME" --project "$PROJECT" || "${create_runtime[@]}"
  exists gcloud iam service-accounts describe "$TICK" --project "$PROJECT" || "${create_tick[@]}"
  "${grant_actas[@]}"   # add-iam-policy-binding is idempotent
fi

# ---------------------------------------------------------------- 3. Workload Identity
step '3. Workload Identity pool + GitHub OIDC provider'
create_pool=(gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT"
  --location global --display-name 'GitHub Actions')
create_provider=(gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project "$PROJECT"
  --location global --workload-identity-pool "$POOL" --display-name 'GitHub OIDC'
  --issuer-uri https://token.actions.githubusercontent.com
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref'
  --attribute-condition "assertion.repository == \"${REPO}\"")
bind_wif=(gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project "$PROJECT"
  --role roles/iam.workloadIdentityUser --member "$PRINCIPAL_SET")
show "${create_pool[@]}"
show "${create_provider[@]}"
show "${bind_wif[@]}"
note 'PROJECT_NUMBER is filled in from `gcloud projects describe` after you answer y.'
note "the attribute condition means only ${REPO} can mint a token for the deployer SA."
if ask; then
  exists gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT" --location global ||
    "${create_pool[@]}"
  exists gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT" \
    --location global --workload-identity-pool "$POOL" || "${create_provider[@]}"
  project_number
  bind_wif[${#bind_wif[@]}-1]="${PRINCIPAL_SET/PROJECT_NUMBER/$PROJECT_NUMBER}"
  "${bind_wif[@]}"
fi

# ---------------------------------------------------------------- 4. Artifact Registry
step "4. Artifact Registry docker repo ${AR_REPO}"
create_ar=(gcloud artifacts repositories create "$AR_REPO" --project "$PROJECT"
  --location "$REGION" --repository-format docker --description 'bcns container images')
grant_ar=(gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --project "$PROJECT"
  --location "$REGION" --member "serviceAccount:${DEPLOYER}" --role roles/artifactregistry.writer)
show "${create_ar[@]}"
show "${grant_ar[@]}"
note "deploy-worker.yml pushes ${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${JOB}:<sha>."
note "artifactregistry.writer is scoped to this repo, not the project — the binding needs the repo"
note 'to exist, which is why it lives here and not in step 2.'
if ask; then
  exists gcloud artifacts repositories describe "$AR_REPO" --project "$PROJECT" --location "$REGION" ||
    "${create_ar[@]}"
  "${grant_ar[@]}"
fi

# ---------------------------------------------------------------- 5. Secrets
step '5. Secret Manager secrets for the worker'
for name in "${SECRET_ENV[@]}"; do
  show gcloud secrets create "$name" --project "$PROJECT" --replication-policy automatic --data-file=-
done
for name in "${SECRET_ENV[@]}"; do
  show gcloud secrets add-iam-policy-binding "$name" --project "$PROJECT" \
    --member "serviceAccount:${RUNTIME}" --role roles/secretmanager.secretAccessor
done
note 'each value is typed at a hidden prompt and piped straight to --data-file=- ; it is never'
note 'echoed, logged, or written to disk. An existing secret is left alone — rotate it with'
note '`gcloud secrets versions add <name> --data-file=-` yourself.'
if ask; then
  for name in "${SECRET_ENV[@]}"; do
    if exists gcloud secrets describe "$name" --project "$PROJECT"; then
      note "$name already exists — keeping it."
    else
      printf '  value for %s (hidden): ' "$name"
      read -rs value || { printf '\n'; echo "  no input for $name — aborting before a half-set secret." >&2; exit 1; }
      printf '\n'
      printf '%s' "$value" |
        gcloud secrets create "$name" --project "$PROJECT" --replication-policy automatic --data-file=-
      unset value   # printf '%s' keeps a pooler URL free of the trailing newline pg would reject
    fi
    gcloud secrets add-iam-policy-binding "$name" --project "$PROJECT" \
      --member "serviceAccount:${RUNTIME}" --role roles/secretmanager.secretAccessor >/dev/null
  done
fi

# ---------------------------------------------------------------- 6. Cloud Run Job
step "6. Cloud Run Job ${JOB}"
job_env="SUPABASE_URL=${SUPABASE_URL:-<export SUPABASE_URL>},BCNS_ALERT_EMAIL=${BCNS_ALERT_EMAIL:-<export BCNS_ALERT_EMAIL>},BCNS_ALERT_FROM=${ALERT_FROM},TASK_COUNT=${TASK_COUNT}"
job_secrets="DATABASE_URL=DATABASE_URL:latest,SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest,RESEND_API_KEY=RESEND_API_KEY:latest"
create_job=(gcloud run jobs create "$JOB" --project "$PROJECT" --region "$REGION"
  --image us-docker.pkg.dev/cloudrun/container/job
  --service-account "$RUNTIME"
  --set-env-vars "$job_env" --set-secrets "$job_secrets"
  --tasks "$TASK_COUNT" --parallelism "$TASK_COUNT"
  --task-timeout 600 --max-retries 0 --cpu 1 --memory 1Gi)
grant_dev=(gcloud run jobs add-iam-policy-binding "$JOB" --project "$PROJECT" --region "$REGION"
  --member "serviceAccount:${DEPLOYER}" --role roles/run.developer)
grant_ops=(gcloud projects add-iam-policy-binding "$PROJECT"
  --member "serviceAccount:${DEPLOYER}" --role roles/run.viewer --condition None)
show "${create_job[@]}"
show "${grant_dev[@]}"
show "${grant_ops[@]}"
note "Google's placeholder image is a stand-in: deploy-worker.yml's \`jobs update\` replaces it with"
note 'the real one on the first deploy, but it needs the job to already exist. Env and secrets are'
note 'set here only — the workflow never touches them.'
note "run.developer is scoped to this job, which covers the workflow's only Cloud Run write."
note 'run.viewer is project-wide because `jobs update` polls the update operation and run.operations.get'
note 'is only grantable at project scope; it is read-only, so the deployer keeps no project-level write.'
note "BCNS_ALERT_FROM=${ALERT_FROM} must be a Resend-verified sender or every alert send is rejected."
if ask; then
  if [[ -z "${SUPABASE_URL:-}" || -z "${BCNS_ALERT_EMAIL:-}" ]]; then
    echo '  skipped: export SUPABASE_URL and BCNS_ALERT_EMAIL, then re-run this step.' >&2
  else
    if exists gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION"; then
      note "${JOB} already exists — keeping it. Change env with \`gcloud run jobs update\`."
    else
      "${create_job[@]}"
    fi
    "${grant_dev[@]}"   # the job exists by here, either way
    "${grant_ops[@]}"
  fi
fi

# ---------------------------------------------------------------- 7. Cloud Scheduler
step "7. Cloud Scheduler ${SCHEDULER_JOB} (*/5 * * * *)"
run_uri="https://${REGION}-run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
grant_invoker=(gcloud run jobs add-iam-policy-binding "$JOB" --project "$PROJECT" --region "$REGION"
  --member "serviceAccount:${TICK}" --role roles/run.invoker)
create_sched=(gcloud scheduler jobs create http "$SCHEDULER_JOB" --project "$PROJECT"
  --location "$REGION" --schedule '*/5 * * * *' --time-zone Etc/UTC
  --uri "$run_uri" --http-method POST
  --oauth-service-account-email "$TICK")
show "${grant_invoker[@]}"
show "${create_sched[@]}"
note "the tick SA holds run.invoker on this one job and nothing else — it is deliberately not the"
note 'runtime SA, which can read DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY and RESEND_API_KEY.'
note "creating the scheduler job needs iam.serviceAccounts.actAs on ${TICK}; project Owner has it."
note 'the target is a *.googleapis.com endpoint, so Scheduler sends an OAuth access token, not OIDC.'
note 'Overlapping executions are fine by design (worker_leases, D23).'
if ask; then
  if exists gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION"; then
    "${grant_invoker[@]}"
    exists gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" ||
      "${create_sched[@]}"
  else
    echo "  skipped: ${JOB} does not exist yet — run step 6 first, then re-run this step." >&2
  fi
fi

# ---------------------------------------------------------------- 8. GitHub settings
step '8. GitHub repo settings for deploy-worker.yml'
gh_settings() {
  cat <<EOF
  GITHUB_TOKEN= gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER --repo ${REPO} --body "${1}"
  GITHUB_TOKEN= gh secret set GCP_SERVICE_ACCOUNT --repo ${REPO} --body "${DEPLOYER}"
  GITHUB_TOKEN= gh variable set GCP_REGION --repo ${REPO} --body "${REGION}"
  GITHUB_TOKEN= gh variable set GCP_PROJECT --repo ${REPO} --body "${PROJECT}"
EOF
}
gh_settings "$PROVIDER_RESOURCE"
note 'answer y to look PROJECT_NUMBER up with `gcloud projects describe` and reprint these filled in.'
note 'then run the four yourself — the script never touches GitHub. Merging to main deploys.'
if ask; then
  printf '\n'
  project_number
  gh_settings "${PROVIDER_RESOURCE/PROJECT_NUMBER/$PROJECT_NUMBER}"
fi

printf '\nDone. Remaining manual steps are in docs/deploy-worker.md.\n'
