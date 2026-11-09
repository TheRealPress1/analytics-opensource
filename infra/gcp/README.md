# GCP deployment foundation

Postgres 16 private-IP Cloud SQL, Cloud Run API and always-on worker, Artifact Registry, KMS envelope key, Secret Manager file mounts, audit logging, unexpected-principal alert, a project-scoped budget and GitHub OIDC deployment identity.

Use `terraform init -backend=false`, `terraform validate`, and `terraform test` for offline provider-schema/mock-plan checks. `tests/plan.tftest.hcl` uses only synthetic resource identifiers. Use `terraform init -reconfigure -backend-config=bucket=YOUR_STATE_BUCKET` with authenticated operator ADC for a real plan. Read [the runbook](../../docs/RUNBOOK.md) before applying.

Bootstrap defaults do not deploy services. Configure `deploy_jobs=true` after publishing an immutable API image; run database migration and both KMS checks before setting `deploy_services=true`. No plaintext secret payload is accepted by Terraform.

The default `db-custom-1-3840` database is 1 vCPU / 3.75 GiB, zonal, with 20 GiB SSD and PITR. The worker reserves 1 vCPU / 512 MiB continuously and runs at least one instance; the API also keeps one minimum instance with request-based CPU allocation. The budget defaults to **$50/month in alerts, not a spending cap**. These requested resources are expected to exceed that budget when left on for a full month.

Planning estimate, checked 2026-11-09: at the published reference on-demand prices, 730 hours of worker compute is about **$49.93/month before shared free-tier credits**, and SQL compute about **$49.31/month**, so allow **roughly $110+ per month** including approximately $9.86 for an idle minimum API instance, before active API traffic, 20 GiB storage, backups, network, logs, KMS, Secret Manager, registry and dashboard hosting. The source pricing pages default to `us-central1`; confirm the exact `us-east4` calculator quote and account-specific credits before applying. HA SQL increases the baseline. No committed-use purchase or automatic spending shutdown is configured. [Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud SQL pricing](https://cloud.google.com/sql/pricing).

`billing_account_id` must be supplied for the budget resource to exist. Verify the notification channel and budget output before enabling a live pilot. Use a dedicated staging project where possible; import existing KMS names instead of trying to replace them.
