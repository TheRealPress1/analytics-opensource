# Usage analytics architecture

The standalone service owns no host application's accounts or health records. The host backend verifies its own session, chooses an opaque stable subject, then exchanges its app-scoped server key for a 15-minute collector token. The token binds the app, subject and environment. Intake derives all three from the verified token, never the event body.

`POST /v1/events` validates the entire batch against that app's approved schemas, then commits it synchronously in PostgreSQL. A successful acknowledgment means all events are durably accepted or identical duplicates. The key `(app_id, environment, event_id)` is unique; changing content under an existing ID rejects the whole batch. A database transaction and subject advisory lock serialize intake with deletion. A deletion tombstone prevents cached tokens from restoring erased events. A returning user must be assigned a new opaque analytics identity after deletion.

The API and worker connect through the Cloud SQL Node connector with private IP and IAM authentication. They have distinct service accounts and SQL permissions. The worker uses pg-boss for housekeeping and maintains a readiness heartbeat. It is not in the durable intake path. Workers do not discard historical events or invent missing events.

The Next.js dashboard uses app-scoped server keys solely in server components. GitHub OAuth and an explicit verified-email or numeric-ID allowlist protect real data. Vercel has no database connection. Each app's registered browser origins govern its collector CORS response. Native apps have no Origin header.

## Metric definitions

All dates are UTC. Selected start/end dates are inclusive. Today's counts are incomplete and the dashboard labels them accordingly. Event dates come from the client event timestamp; intake accepts at most 30 days old or five minutes ahead, and ignores future timestamps in analytics until the current clock reaches them. Coverage means earliest/latest recorded event, not proof that collection was enabled for every install or day.

- **Events:** accepted event rows in the selected dates; repeated delivery does not increase this number.
- **Active users:** distinct subjects with a selected event. DAU/WAU/MAU cards use today, the last 7 dates, and the last 30 dates through now, independently of the chart's selected range.
- **Sessions:** distinct `(subject, sessionId)` pairs with a selected event. Daily session counts can sum above range sessions when one session crosses midnight. Sessions reset at explicit SDK boundaries, not an inferred browser inactivity timeout.
- **Top events:** per-name counts and distinct subjects in the range.
- **Retention:** first-observed-activity UTC date defines the cohort. D1/D7/D30 is the fraction returning on exactly that later UTC date. A return day that has not fully ended is null, never zero. Only cohorts starting in the selected range are shown, but the API reads prior history to avoid reclassifying existing users as new.
- **Funnels:** distinct subjects completing each specified event in strictly increasing timestamp order inside the selected range. A stage's conversion divides by the preceding stage; the first stage is 100% when nonempty. Same-timestamp events are not assumed ordered. No cross-session restriction is imposed.
- **Event filter:** applies to the activity universe, including first observation and retention; remove it to inspect overall app retention. A funnel with steps excluded by the filter correctly has zero qualifying users.

No historical meals are converted into fictional sessions, app opens, or signup events. New instrumentation starts measuring at installation/enablement. Existing aggregate business data belongs in a separately labeled import.

## Current bounds

The first interactive implementation computes exact metrics from at most 100,000 rows per app/environment, and supports date ranges up to ten years. It fails explicitly above those limits; it never reports a capped sample as all-time data. Replace the history query with SQL/warehouse aggregation before scaling beyond that threshold. The worker's current responsibility is queue liveness and rate-limit cleanup, not a claimed analytics rollup.

Intake caps are 50 events, 64 KiB, 10 properties per event, 120 requests/minute/subject and 6,000/minute/app, counted in PostgreSQL across instances. The service does not provide bot-proof telemetry: an authenticated app user can fabricate their own usage. Analytics must never authorize payments or clinical decisions.

## Data handling

SDK collection begins disabled. Enable only under the host app's stated analytics choice. Disable, sign-out and identity switch clear pending events and cancel/fence in-flight callbacks. Offline events expire after seven days. Server-side deletion requires the host backend/server key. SDK disable stops future delivery but cannot retract a request already committed by the server; use the deletion endpoint when erasure is required.

App owners choose retention and approved event schemas. Store opaque subjects and minimal named events. Do not configure schemas to encode patient records, meals, free text, identifiers, prompts, device readings or other sensitive content. Public examples and tests use synthetic identities only.
