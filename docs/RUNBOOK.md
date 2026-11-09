# Operations runbook

This is a deployment procedure, not evidence that infrastructure is already live. Keep project IDs, deployment identities, keys, connection settings and evidence in the consuming app's private workspace. The reusable repository contains synthetic examples only.

## Prepare and validate

1. Select an existing billed GCP staging project and `us-east4`. Review the roughly $110+/month baseline in [infra/gcp/README.md](../infra/gcp/README.md); the $50 budget is an alert, not a cap.
2. Authenticate the operator with short-lived Google credentials/ADC. Bootstrap an access-restricted, versioned GCS Terraform state bucket in the selected project. Do not create a service-account JSON key. Operators need provisioning privileges; application CI does not get them.
3. Copy `infra/gcp/terraform.tfvars.example` to a private, ignored file and fill project, numeric GitHub repository/owner IDs, notification email and billing account. Keep `deploy_jobs=false` and `deploy_services=false`. Check whether the `subkit` key ring or `credentials-kek` already exists and import it when appropriate.
4. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, then `terraform -chdir=infra/gcp init -backend=false`, `validate` and `test`. These provider/mock checks do not contact or modify GCP.
5. Reinitialize with the real GCS backend, create a saved plan using the private variable file, inspect it, then apply that exact plan. Review especially IAM bindings, public API ingress, SQL private IP, compute sizing, backups, alert recipients and billing budget. `budget_configured` must be true for the pilot.

## First deployment

Use three stages to avoid starting a service before its database exists:

**Foundation:** apply with services/jobs disabled. Terraform creates secret metadata without values. Generate the token-signing secret outside Terraform and add a Secret Manager version through stdin or a mode-0600 file. For example, pipe `openssl rand -base64 48` directly to `gcloud secrets versions add "$TOKEN_SECRET_NAME" --data-file=- --project="$GCP_PROJECT_ID"`; never echo its payload or put it in command arguments. Configure `token_secret_version` to that explicit version. The admin-key secret is reserved for provisioning and has no runtime accessor. Application keys are created by `app:create` and remain in the host backend or dashboard's server environment.

Build and push both Dockerfiles from the repository root to the Terraform-created Artifact Registry, recording immutable image digests. The API image also includes the database migration and KMS acceptance entrypoints. No secret, Terraform state or GitHub credential file belongs in the build context.

**Bootstrap jobs:** set `deploy_jobs=true`, `api_image` to its digest, leave services disabled, review/apply the plan. As the existing database administrator, connect to the dedicated analytics database through an approved private route and apply `infra/gcp/bootstrap-grants.sql` with the `database_users` output. IAM identities alone do not grant SQL table privileges. The script grants the migrator CREATE on `public` and makes the worker owner only of the `pgboss` schema. In production the worker sets `createSchema=false`; it can manage the existing queue schema without database-wide CREATE privileges.

Run the migration job, then apply `runtime-grants.sql` as the migration owner or database administrator. Do not put a database-owner password in Terraform or Cloud Run. Run `app:create` under the migration/provisioning identity and store the returned app secret in its intended host backend; the API and worker do not need permission to create apps. Handle any provisioning output as a credential, never an analytics log.

Run both KMS jobs so the actual API and worker service accounts prove encrypt/decrypt access:

```sh
gcloud run jobs execute "$SERVICE_PREFIX-kms-api" --region=us-east4 --wait
gcloud run jobs execute "$SERVICE_PREFIX-kms-worker" --region=us-east4 --wait
gcloud run jobs execute "$SERVICE_PREFIX-migrate" --region=us-east4 --wait
```

Each KMS job encrypts ephemeral random bytes, decrypts them, compares them, and emits only `{"check":"kms-envelope-roundtrip","passed":true}`. No credential is stored or printed. Confirm both job success and the audit-log principals. A local crypto test is insufficient for this requirement.

**Services:** set `deploy_services=true`, pin both image digests, review/apply the plan. The API is internet reachable for mobile clients; its routes require app keys or short-lived collector tokens. The worker has internal-only ingress and no unauthenticated invocation grant. SQL has no public IP. The Secret Manager token is mounted at `/var/run/secrets/token/value`; environment variables contain only its file path and nonsecret connector metadata.

## Live acceptance

- `/healthz` reports process liveness; `/readyz` proves the API database/schema and worker database/pg-boss are ready. Both listen on port 8080. Cloud Run startup probes use `/readyz`; liveness uses `/healthz` so transient database trouble does not cause a restart storm.
- Verify Cloud SQL private IP only, IAM authentication enabled, connector access under each intended identity, database migrations complete and least-privilege SQL grants applied.
- Record successful API and worker KMS checks, correct key ring/key/90-day rotation, and Data Access audit entries. A third identity without the key role must fail; test this only with a deliberate disposable staging identity rather than granting broad access.
- Verify Secret Manager access by API only for its signing secret, and no plaintext secret values in service environment/configuration or Terraform state. Worker does not read the signing secret.
- Verify a synthetic development batch ingests once, retrying the same event IDs deduplicates, and another app's token cannot read or write that app's events. Production and development charts must stay separate.
- Verify dashboard sign-in allowlisting and server-only app key handling. Dashboard deployment is separate from this GCP workflow.
- Verify the Monitoring email channel, budget thresholds (50%, 90%, 100%, forecast 100%) and unexpected KMS principal alert. Budget alerts can lag and never stop spending.
- Capture revision names, image digests, migration result, aggregate-only acceptance results and known limitations in the private consuming workspace. Do not claim a successful deployment based on a plan or mock tests.

## GitHub deployment

Create a protected `staging` GitHub environment and configure its allowed branch as `main`. Populate repository/environment variables from Terraform outputs: `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_SERVICE_PREFIX`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`. The OIDC trust requires the exact immutable repository/owner IDs, ref, workflow path and environment. If the default branch or environment changes, update both Terraform and the workflow deliberately.

`.github/workflows/deploy.yml` is manually dispatched. It tests, builds, obtains short-lived federated credentials, publishes digest-pinned images, runs synthetic KMS checks and a migration, then updates worker/API and checks API readiness. It uses a federated 30-minute OAuth token in a mode-0600 runner-temporary file, refreshed before rollout, so a ten-minute migration does not reuse an expired five-minute GitHub OIDC assertion. The file is removed on completion. It cannot provision unrelated infrastructure or read secret payloads directly. It can deploy code that uses the runtime identity, so protect the branch and environment accordingly. Terraform ignores image drift after creation because this workflow owns application revisions; infrastructure configuration stays Terraform-managed.

## Shutdown, recovery and rotation

Cloud Run may terminate even minimum instances. Handle SIGTERM, stop taking queue work, close pg-boss and database connections, and exit within ten seconds. Failed in-flight jobs must remain retryable. pg-boss lives in Postgres; do not clear its schema to repair a stalled worker.

On a bad application release, move API and worker traffic back to the last healthy revisions using Cloud Run revision traffic controls, verify `/readyz`, and inspect aggregate-only errors. An image rollback does not undo a database migration. Migrations must remain compatible with the prior release; make a new forward repair for schema defects. Record both services' revision IDs before each release.

For a database incident, inspect Cloud SQL health/private networking and the exact-instance IAM conditions before changing credentials. Restore a backup/PITR clone into a separate staging instance, apply equivalent IAM users/grants, then run synthetic dedupe and analytics checks against the clone. Do not switch production to a restored database until the recovery point and missing events are understood. Run and record a restore drill before production use; having backups configured is not proof of restore success.

KMS rotates the primary version every 90 days. Existing envelopes retain their wrapping version and remain readable while it is enabled. Keep old versions until data has been rewrapped and verified. Never destroy a key version as routine rotation. On unexpected-principal alerts, examine the audit entry and recent grants/deployments, remove unauthorized access and investigate; avoid destroying keys that would render data unreadable.

To rotate the token signing secret, create a new Secret Manager version outside Terraform, update its pinned version, and deploy a revision. Existing short-lived collector tokens may need refresh; clients should obtain a new token from their host backend. Admin and app keys use their own issuance/revocation process. No long-lived GCP service-account key is required.

## Optional Pub/Sub foundation

It is disabled by default and unused by this release. Enabling it creates generic topics only. No billing providers, RTDN publisher permissions, push endpoint or unauthenticated consumer are configured. Define and test an authenticated message contract before connecting it to a future feature.

## Repeat the database privilege acceptance test

After building core/db, run `TEST_ADMIN_DATABASE_URL=postgresql://LOCAL_ADMIN@127.0.0.1:PORT/LOCAL_TEST_DB node infra/gcp/scripts/verify-runtime-grants.mjs` against a disposable local PostgreSQL 16 cluster. The script refuses non-loopback hosts, creates its own randomly named database and three non-superuser roles, applies the exact grant scripts, exercises the application repository and pg-boss under those roles, verifies forbidden operations fail, and removes only its own database/roles. It never modifies tables in the supplied admin connection database. This checks SQL permissions; GCP IAM/private networking still need staging acceptance.
