# Implementation contract

Usage analytics only; no billing, purchases, subscriptions, paywalls or medical data.
Working SDK name SubKitAnalytics. Repo analytics-opensource, packages @subkit/*.
HTTP JSON uses camelCase; event environments production/development. UTC date boundaries.

## SDK/API

POST /v1/events, Authorization Bearer short-lived collector JWT, body {events: [{id: UUID, name: string, occurredAt: ISO8601 UTC, sessionId: UUID, properties: Record<string, boolean|number|string>}]}. Max 50 events / 64KiB. Token binds appId, subject (pseudonymous ID), environment. No identity in event body. Success {accepted: number, duplicates: number}; 4xx permanent except 401,408,429; retry network, 401,408,429,5xx retaining original IDs. A 401 obtains a fresh token from the provider on retry to handle expiration or rotation after issuance. Collector token obtained from host backend, never store a server key in client. SDK requires explicit enabled/consent configuration; no automatic tracking; disable clears pending events and fences late requests. Persist only allowed sanitized events; cap queue and expire after 7 days. Tokens fetched via closure immediately before flush, never persisted. Session ID resets on account switch. No anonymous merge/alias in v1.

POST /v1/server/sessions, Authorization Bearer app sk_ key, body {subject: string, environment: production|development} → {token, expiresAt}. Host backend authenticates its user before choosing opaque stable subject. Dashboard and server endpoints require sk_, which is scoped to one app. GET /v1/server/app → {id,name,slug,eventNames}. GET /v1/server/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&environment=development[&event=name][&funnel=a,b,c]. Dates inclusive, default last30days; range=all allowed. GET /v1/server/events?environment=&limit=50 lists sanitized events. No direct DB access from dashboard.

## Analytics response

{ app: {id,name,slug}, environment, from, to, generatedAt, totals: {events,activeUsers,sessions,eventsToday,activeToday,active7Days,active30Days}, daily: [{date,events,activeUsers,sessions}], topEvents: [{name,count,users}], retention: [{cohortDate,users,day1: number|null,day7: number|null,day30: number|null}], funnel: [{name,users,conversionRate: number|null}], coverage: {firstEventAt: string|null,lastEventAt: string|null} }. Retention values are proportions; null means cohort hasn't matured. Funnel counts sequential occurrences per subject within chosen dates, same timestamps are not sequential. DAU excludes events filtered out by event selection consistently. Count actual sessionIds scoped by subject. Empty days filled with zero, no invented historical events.

## Infrastructure ownership

Cloud Run API/worker Node22 us-east4, Postgres16 privateIP only via connector IAM auth, worker pg-boss continuous CPU, Vercel dashboard server-only API keys. Secret files: SUBKIT_TOKEN_SECRET_FILE, SUBKIT_ADMIN_KEY_FILE where needed. Connector env: INSTANCE_CONNECTION_NAME, DB_USER, DB_NAME; DATABASE_URL local development only. Core API uses packages/db exported connectDatabase returning {pool,close}; infrastructure agent coordinate this contract with root. Terraform never stores runtime secret values. KMS envelope crypto generic, no store integrations. No Pub/Sub billing resources now unless documented disabled opt-in amendment foundation.

Every test fixture is synthetic. No Geneva identifiers/configs in public repo. Geneva pilot stays in Geneva repo under integrations/analytics, separate from reusable SDK.
