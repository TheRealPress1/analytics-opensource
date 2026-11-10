# Embedded SQLite analytics

`@subkit/db-sqlite` stores usage analytics in a host application's existing
better-sqlite3 database. It creates only `subkit_analytics_*` tables and indexes.
It never opens or closes the supplied connection, changes PRAGMAs, starts a worker,
or reads unrelated application tables. The host remains responsible for database
access, backup/restore, storage capacity, and connection lifetime.

Install the matching `@subkit/core`, `@subkit/api`, and `@subkit/db-sqlite` 0.2.0
packages together. When installing release archives before registry publication,
pass all three `.tgz` files to `npm install` in the same command. The host supplies
its existing `better-sqlite3` 12.x dependency. PostgreSQL and the Cloud SQL connector
are not dependencies of the embedded entry points.

```ts
import { createApi } from "@subkit/api";
import { migrateSQLite, SQLiteRepository } from "@subkit/db-sqlite";

// existingDatabase is the host's existing better-sqlite3 Database handle.
// Run this explicitly during provisioning, not during a Next.js build.
migrateSQLite(existingDatabase);
const repo = new SQLiteRepository(existingDatabase, { maxStoredEvents: 100000 });
const api = createApi({
	repo,
	tokenSecret: signingKeyBytes, // at least 32 bytes, obtained server-side
	limits: { eventsPerApp: 300, eventsPerCollector: 30, analytics: 30, sessions: 120 },
});
// Delegate a standard Request to api.fetch(request), after stripping your mount prefix.
// Keep all existing staff authorization checks around your dashboard routes.
```

`migrateSQLite` is synchronous, additive, transactional, and checksums applied
migrations. It rejects table collisions or a changed applied migration rather than
silently adopting another schema. It does not run from the constructor.

Provision an app with `await repo.createApp({name,slug,eventSpecs,allowedOrigins},
serverKey)`. Persist its random `sk_` server key only in the host's secure server
configuration; the database stores its hash. `appBySlug`, `appByKey` and `listApps`
allow a host provisioning command or staff app selector to reuse existing apps.
`createApp` does not rotate keys or overwrite an existing slug.

The reusable Hono factory preserves collector JWT authentication, app/environment
scope, property allowlists, rate limiting, subject tombstones, and conflict-aware
batch deduplication. The host backend must authenticate the member before issuing
a collector token. Never expose server keys or choose a member identity from an
untrusted request body. Preserve explicit collection consent and opt-out handling.

SQLite writes and deletion use synchronous immediate transactions. A batch commits
in full or rolls back on any conflict. Separate connections serialize deletion and
ingestion; a committed tombstone rejects later retries. `SQLITE_BUSY` reaches the
API's retryable 503 response; the host controls SQLite's existing busy timeout.
Analytics calls inside an outer host transaction follow that transaction's commit
or rollback: do not acknowledge an HTTP request before the outer transaction commits.

No continuous pg-boss worker is needed. The host can call
`await repo.cleanupRateLimits({before: new Date(Date.now()-60*60_000), limit:1000})`
from an existing maintenance task. Each call removes at most the requested number
of expired analytics rate-limit rows (maximum 10,000); it never removes events,
tombstones, or host rows. Choose a cutoff older than active request windows.

Interactive history currently has a 100,000-event limit per app/environment and
calculates charts in memory. SQLite shares the host's write lock and disk: rate
limits and small batches reduce contention but do not guarantee unused capacity.
The database's existing backup must include these tables before real collection.

`maxStoredEvents` is an optional global cap across the adapter's events table. It
is checked inside the write transaction; identical retries still succeed at the
cap, and an overflowing batch rolls back in full. The API returns
`503 storage_capacity` with `Retry-After: 60`, allowing SDK retries instead of
discarding new events. Subject deletion frees capacity, but no rows are
automatically sampled or deleted. Omit the option for the generic uncapped mode.
The cap bounds event growth; it is not a cloud billing limit.
