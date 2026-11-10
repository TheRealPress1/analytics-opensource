# Decisions

Recorded 2026-11-09. These describe implemented source and intended deployment configuration, not a claim of a live deployment.

## Usage analytics is the product

The initial subscription-platform prompt is superseded by the user's clarification: usage analytics only. There are no purchases, subscriptions, entitlements, store adapters, billing integrations or remote paywalls. Geneva is a consumer of the reusable SDK. Its patient records, credentials and app-specific configuration stay outside this repository. All test fixtures are invented.

## Embed in the host database for a small deployment

Added 2026-11-10. An existing Node application can mount the same authenticated HTTP API and supply its existing `better-sqlite3` handle. The adapter creates only prefixed `subkit_analytics_*` tables and never changes the host journal mode, closes its connection or touches unrelated records. Explicit transactional migrations and a bounded cleanup method replace a separate database service and continuous queue worker. Event acceptance remains synchronous and durable according to the host database settings. App/environment isolation, deletion tombstones and idempotent intake remain part of both storage adapters.

The host remains responsible for access controls, backups, restores and secret storage. Sharing existing hosting does not make storage or traffic inherently free; it removes the need to provision separate services. The Geneva pilot uses this mode to fit its additional-hosting budget. The generic SDK and service remain independently reusable.

## Dedicated GCP deployment (optional)

The API and continuous pg-boss worker run on Cloud Run in `us-east4`; the dashboard remains a Next.js application suitable for Vercel. Postgres 16 runs on private-IP Cloud SQL. The application connector uses attached service-account identity with automatic IAM database authentication, not a database password. Direct VPC egress provides private network reachability; the connector alone does not create that path. [Cloud SQL Node connector](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector), [IAM authentication](https://docs.cloud.google.com/sql/docs/postgres/iam-logins).

The worker has instance-based CPU allocation, minimum and maximum one instance, request concurrency 80 and a 30-second HTTP timeout. pg-boss provides durable job coordination; a Cloud Run instance can still be terminated. Shutdown must stop claiming work and release resources within the platform's grace period. [Cloud Run billing/background execution](https://docs.cloud.google.com/run/docs/configuring/billing-settings).

## IAM boundaries

API, worker, migration and CI deployment use separate identities. SQL Client and Instance User roles use exact-instance IAM Conditions; Cloud SQL does not offer a Terraform per-instance policy resource equivalent to a Secret Manager secret policy. Database grants are a separate bootstrap requirement. Credentials in Secret Manager use secret-level access, the KMS role is bound to one CryptoKey, image writes to one repository, and deployment permissions to existing Cloud Run services/jobs plus their exact service accounts. No project Editor/Owner role is granted to a runtime or deployment identity. [Cloud SQL IAM Conditions](https://docs.cloud.google.com/sql/docs/postgres/iam-conditions).

GitHub OIDC trusts numeric repository and owner IDs, the `main` ref, this exact deployment workflow and the protected `staging` environment. No exported service-account JSON key is used. Terraform bootstrap is an operator action; CI only publishes images, runs acceptance/migration jobs and updates existing services. [Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines).

## KMS envelope encryption

A new 256-bit data key and 96-bit IV are generated per encryption. AES-256-GCM encrypts locally; KMS wraps the data key. Authenticated context binds app, environment, purpose and record. The envelope stores only wrapped key, ciphertext, IV, authentication tag and key metadata. The caller's configured key determines decryption; ciphertext cannot select an arbitrary KMS key. KMS transport integrity fields are checked. Plaintext data-key buffers are zeroed where controlled by this code; JavaScript/SDK internal copies cannot be guaranteed erased.

The key ring is `subkit`, key `credentials-kek`, with a 90-day rotation period. Old key versions must remain enabled until their envelopes have been rewrapped or retired. This generic helper does not introduce store credentials or health data into usage analytics. Both runtime identities receive key-scoped encryption/decryption permissions as requested; staging acceptance jobs test each identity independently using ephemeral synthetic bytes. [Envelope encryption](https://docs.cloud.google.com/kms/docs/envelope-encryption), [KMS integrity verification](https://docs.cloud.google.com/kms/docs/data-integrity-guidelines).

## Secret values stay out of Terraform

Terraform creates secret containers and permissions, never secret versions or payload data sources. The API signing secret is a version-pinned file mount. The admin bootstrap secret has no routine runtime binding. Plaintext secrets and database URLs are not Cloud Run environment values. The GCS backend itself must be bootstrapped with restricted IAM and versioning; local plans/state and private variable files remain outside the repository.

## Optional Pub/Sub

`enable_pubsub_foundation=false` is the default. Enabling it creates only a generic topic and a dead-letter topic. There is no subscription, Google Play publisher, RTDN endpoint or application integration. pg-boss remains the usage-analytics queue.

## Bootstrap and acceptance are separate

Infrastructure can be created with services disabled, then migration/KMS jobs enabled, then services started after migrations and grants. This avoids a circular dependency where a first `/readyz` probe needs tables that have not been created. Local Terraform mock tests validate configuration properties; they do not prove Google IAM, network routing, KMS access, a migration or a deployed service works. The runbook lists those live acceptance steps explicitly.
