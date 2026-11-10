# analytics-opensource

**Open sourcing RevenueCat-style analytics.** A self-hosted usage analytics service with an installable Swift SDK, TypeScript browser/server SDKs, and a dashboard for multiple apps.

This is an independent implementation. The current release measures app usage: events, active users, sessions, feature adoption, retention, and ordered funnels. It does not process purchases, subscriptions, revenue, or paywalls.

## What works

- Today, 7/30/90-day and all-time views with daily activity charts.
- Daily, weekly and monthly active users; unique sessions and event counts.
- Feature-use rankings, first-observed-activity cohorts, exact-day D1/D7/D30 retention, and sequential funnels.
- Multiple apps with separate server keys and strict production/development separation.
- Collector tokens issued by the host app's authenticated backend. Client SDKs never contain server keys.
- Retry-safe event IDs, atomic deduplication, bounded offline queues, explicit collection enablement and account-switch clearing.
- Approved event/property schemas. Properties support booleans, bounded numbers, and enum values; no arbitrary free-text properties.
- Subject deletion that removes events and rejects existing collector tokens for that identity.
- Cloud Run / private Cloud SQL / KMS / Secret Manager infrastructure, with GitHub OIDC deployment workflow. Vercel hosts the dashboard without database credentials.

This is an early developer release. The interactive API deliberately returns a capacity error above 100,000 events per app/environment instead of silently truncating charts. A SQL/warehouse aggregation path is needed before larger deployments. Infrastructure definitions and local tests are separate from a verified live deployment; follow the acceptance steps before collecting production events.

## Reuse an existing application and database

The embeddable API and SQLite adapter can run inside an existing Node web application, using the same SQLite database connection. Analytics owns only its `subkit_analytics_*` tables. Your host keeps control of authentication, deployment, secrets, database settings and backups. No separate API server, cloud database or continuous worker is required for this mode. See [embedded deployment](docs/EMBEDDED.md).

## Standalone PostgreSQL quick start

Requires Node 22, pnpm 10.33.2, and PostgreSQL 16.

```sh
pnpm install
pnpm build
export DATABASE_URL=postgresql://localhost/analytics
pnpm db:migrate
mkdir -m 700 secrets
node -e "require('node:fs').writeFileSync('secrets/token-key',require('node:crypto').randomBytes(32).toString('base64'),{mode:0o600})"
pnpm app:create examples/app-config.json secrets/example-app.json
SUBKIT_TOKEN_SECRET_FILE=secrets/token-key pnpm dev:api
```

In another terminal with the same database configuration, run `pnpm dev:worker` on a different local `PORT`, such as 8081. The API defaults to 8080. Secret files and local environment files are gitignored. The create-app command writes a server key to the specified private file; it never prints it.

For a fictional dashboard preview, run:

```sh
SUBKIT_DEMO=true pnpm --filter @subkit/dashboard dev
```

Visit http://localhost:3100. The synthetic preview is explicitly labeled and cannot bypass authentication in a production build. Real data requires GitHub OAuth, an allowlist, and server-side app keys; see [dashboard setup](docs/DASHBOARD.md).

## Install in an app

- **iOS/macOS:** add this repository as a Swift package and select `SubKitAnalytics`. See [Swift integration](docs/IOS.md).
- **Browser:** use `@subkit/web` from a built package archive. It accepts a host-provided collector-token callback and starts disabled. See [integration](docs/INTEGRATION.md).
- **Backend:** use `@subkit/server` to issue scoped collector tokens and read analytics. Authenticate the app's user before selecting their opaque subject.

The SDK packages are not implicitly published to npm. To make installable archives from a checkout, run `pnpm --dir packages/sdk-web pack --pack-destination ../../artifacts` and the equivalent command for `packages/sdk-server`. Both have zero runtime dependencies. Swift uses repository tags directly.

## Deploy and verify

The dedicated GCP configuration is optional; it is not required for an embedded installation. [GCP infrastructure](infra/gcp/README.md) describes the staged bootstrap, IAM database grants, secret provisioning, keyless CI deployment, and costs. [Runbook](docs/RUNBOOK.md) covers backups, KMS verification and incident recovery. Infrastructure tests use Terraform mocks; they do not establish that a cloud service is live.

```sh
pnpm build
TEST_DATABASE_URL=postgresql://localhost/analytics_test pnpm test
pnpm typecheck
pnpm lint
swift test
```

Database integration tests require a disposable PostgreSQL database. CI supplies PostgreSQL 16 and runs the real HTTP/database boundary tests, Swift tests, and Terraform validation/mock plans.

See [architecture and metric definitions](docs/ARCHITECTURE.md) and [implementation decisions](docs/DECISIONS.md). Fixtures are fictional and contain no app customer data.
