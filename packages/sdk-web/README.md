# @subkit/web

Explicit, app-scoped usage analytics for modern browsers. This package has no
runtime dependencies. It does not capture screens, inspect the DOM, fingerprint
devices, read medical records or implement subscriptions.

Build with `pnpm --filter @subkit/web build`, then create a distributable archive
with `pnpm --filter @subkit/web pack`. Install that reviewed archive into a consumer
with `pnpm add /path/to/subkit-web-0.1.0.tgz`. A GitHub release can distribute the
same archive; an npm registry publication is not required.

```ts
import { AnalyticsClient, browserQueueStorage } from "@subkit/web";

const analytics = await AnalyticsClient.create({
	baseUrl: "https://analytics.example.com",
	appNamespace: "my-app",
	subject: authenticatedAnalyticsSubject,
	environment: "production",
	enabled: memberAllowsUsageAnalytics,
	eventSpecs: {
		app_opened: {},
		feature_used: { feature: { type: "enum", values: ["search", "favorites"] } },
	},
	storage: browserQueueStorage(window.sessionStorage),
	tokenProvider: async (signal) => {
		const response = await fetch("/api/analytics-session", { signal });
		if (!response.ok) throw new Error("Collector session unavailable");
		return response.json();
	},
});

analytics.track("app_opened");
analytics.track("feature_used", { feature: "search" });
```

`authenticatedAnalyticsSubject` and `memberAllowsUsageAnalytics` come from your
application. Your `/api/analytics-session` endpoint must authenticate the current
member and choose their stable opaque subject itself. Use `@subkit/server` on that
backend to issue the collector token. No server key belongs in browser code or a
public environment variable. The SDK rejects server keys as collector tokens.

Collection defaults to disabled and does not become enabled merely by constructing
the client. The default queue is in memory. Optional browser storage persists only
approved event fields under a hashed account/app/environment scope, never the token
or raw subject. Other scripts running on the same origin can still read browser
storage: hashing a storage key is not encryption or anonymization. The example uses
`sessionStorage` so each browser tab owns its queue and reloads preserve events.
Use one client instance per app/account/storage scope. Sharing the same localStorage
scope across multiple active tabs requires a host-provided cross-tab storage
coordinator; the simple storage adapter does not provide locking or merging.

Call `analytics.setEnabled(false)` on withdrawal and `analytics.signOut()` on
sign-out. Both clear pending events and cancel requests. A request already accepted
by the server cannot be recalled this way. Change accounts with
`await analytics.setIdentity(newSubject, newAccountTokenProvider, newAccountChoice)`;
the default new-account choice is disabled. Late requests cannot remove or send the
new account's queue. `dispose()` stops timers and cancels work while retaining the
same-account queue for a later launch.

Events keep stable UUIDs across retries and are only removed after a complete
`accepted + duplicates` acknowledgment. Batches contain up to 50 events / 60 KiB.
The default queue holds 500 events and expires events after seven days; the oldest
pending event is dropped if the queue exceeds its configured bound. Transient
failures retry with bounded exponential backoff. Other `4xx` errors discard the
rejected batch and return its size in `discarded`; `401`, `408` and `429` remain retryable.
A `401` invokes the token provider again on retry, preserving event IDs if the
credential expired or rotated between issuance and ingestion.
`onDelivery` receives acknowledgment counts without any payload or credentials.

Properties must match a declared boolean, bounded finite number or fixed string
vocabulary, and the server must use the same allowlist. Sessions reset after 30
minutes of inactivity, account changes or explicit `startSession()`. Call `flush()`
on foregrounding when useful. Browsers may suspend timers or terminate a page at
any time; this SDK does not claim guaranteed unload delivery.

HTTPS is required, redirects are refused, and requests omit browser cookies.
For local development only, set `allowLocalhostHttp: true` and use a localhost URL
with `environment: 'development'`. `automaticFlush: false` permits explicit flushing.

Use `pnpm exec vitest run packages/sdk-web/src/index.test.ts` for the SDK tests.
