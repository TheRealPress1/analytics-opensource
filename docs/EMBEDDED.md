# Embed analytics in an existing Node application

This mode reuses a web application's process and existing SQLite database. It does not create cloud resources or start a background worker. The host can keep its existing dashboard, authentication, deployment and backups.

## Install

The developer release supplies archives for `@subkit/core`, `@subkit/api` and `@subkit/db-sqlite`. Install all three matching archives together with your existing `better-sqlite3` dependency. The packages are not published to npm. Pin the archives and their checksums in your consuming repository so builds do not depend on an unpublished package name or an unversioned download.

## Database ownership

Pass the host's existing `better-sqlite3` handle to `SQLiteRepository`. Run `migrateSQLite(handle)` explicitly during deployment or guarded runtime initialization before serving analytics requests. Migration creates only `subkit_analytics_*` tables and indexes, records a checksum and rejects incompatible prior migrations. It does not change host PRAGMAs, close the handle, replace the database, or modify other application tables.

Do not run migrations during framework builds. A build must not require access to a live database. Use synthetic fixtures when testing; never copy a live customer database into this repository.

The SQLite adapter uses database transactions for atomic batches, event-ID deduplication and subject deletion. A deleted subject cannot be revived by an outstanding collector token. Development and production data remain separate within each app.

## HTTP and authentication

`createApi({ repo, tokenSecret })` from `@subkit/api` returns the HTTP handler without starting a listener or connecting to PostgreSQL. Mount it within the host server, for example at `/api/app-analytics`. Configure each SDK with that complete base URL; the SDK adds `/v1/...` below it.

The signing key must contain at least 256 bits of secret material. Load it through the host's existing server-side secret facility, or derive a dedicated key from a suitable existing secret with a cryptographic, purpose-separated derivation. Never expose it in public environment variables, client bundles, URLs or logs.

The host's account backend issues short-lived collector tokens only after authenticating the member. Server `sk_` keys stay on trusted backends. Analytics endpoints validate their bearer credentials even when the host exempts those exact paths from an interactive staff-login redirect. Keep the rest of the application behind its existing authentication. A reverse proxy or access gateway also needs to pass these specific machine-authenticated routes; application middleware alone cannot override an upstream login wall.

Staff dashboard reads must use the host's established session and permission checks. Do not expose raw repositories or app keys to the browser. Preserve the existing application's CSRF protection on its other routes.

## Housekeeping and operations

Use the repository's bounded `cleanupRateLimits` method from an existing scheduler or a throttled host maintenance hook. It removes expired request-counter rows only. Accepted events do not wait for this task; they are written in the request transaction. No pg-boss process is needed in embedded mode.

Keep analytics tables in the same database's backup and restore coverage. Restore into an isolated test environment to verify recovery. Configure request-rate limits for the consuming app, and inspect aggregate traffic/storage rather than logging event bodies or credentials.

Hosts can set `new SQLiteRepository(handle, { maxStoredEvents: 100000 })` to bound saved events across the embedded database. The limit is checked in the ingestion transaction: duplicate retries still work, while a batch that would exceed it rolls back and returns a retryable `503 storage_capacity` response. Existing history is not deleted or sampled. SDK queues are bounded, so operators must resolve a full store before queued events expire; this row limit is not a cloud spending cap.

The developer preview still rejects interactive history above 100,000 events per app/environment instead of silently truncating results. It requires an aggregation strategy before larger histories. Hosting reuse does not remove this limit.

## Acceptance

- Prove a synthetic development batch is accepted once and an identical retry is deduplicated.
- Check app and environment isolation, deletion with an outstanding token, staff permissions and invalid-token rejection.
- Verify the host's unrelated tables and database settings are unchanged after migration, ingestion, cleanup and deletion.
- Verify the public production URL returns JSON authentication failures to SDKs instead of an interactive login page.
- Confirm the host's existing backup covers the new tables, and keep production member collection disabled until the host app's identity and consent integration is ready.
