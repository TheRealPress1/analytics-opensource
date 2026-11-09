# Swift usage SDK

The root `Package.swift` exports `SubKitAnalytics` for iOS 16+ and macOS 13+.
It collects only events your app explicitly records. It does not inspect screens,
health records, files, advertising identifiers or the user's device settings.

## Install

In Xcode, add the `analytics-opensource` repository as a Swift package and select
the `SubKitAnalytics` library. During development, use a local checkout:

```swift
.package(path: "../analytics-opensource")
```

In a consuming package target, depend on
`.product(name: "SubKitAnalytics", package: "analytics-opensource")`.
Pin a reviewed tag or commit when installing from GitHub; do not follow the default
branch automatically in a production application.

## Configure after authentication

Your backend authenticates the member, selects their stable opaque analytics
subject, and calls `POST /v1/server/sessions` with its server key. The response has
`token`, `subject`, `environment` and `expiresAt`. Return that response only to its
authenticated owner. Never embed an `sk_` key or an administrator credential in
an app, or accept an arbitrary subject supplied by the phone at this endpoint.

```swift
import SubKitAnalytics

let configuration = AnalyticsConfiguration(
    baseURL: URL(string: "https://analytics.example.com")!,
    appNamespace: "my-app",
    environment: .production,
    events: [
        AnalyticsEventDefinition("app_opened"),
        AnalyticsEventDefinition("onboarding_completed"),
        AnalyticsEventDefinition("feature_used", properties: [
            "feature": .choice(["search", "favorites"])
        ])
    ]
)
let directory = URL.applicationSupportDirectory
    .appendingPathComponent("UsageAnalytics", isDirectory: true)
let analytics = try SubKitAnalytics(
    configuration: configuration,
    subject: authenticatedAnalyticsSubject,
    enabled: memberAllowsUsageAnalytics,
    storage: FileAnalyticsQueueStorage(directory: directory),
    tokenProvider: {
        // Implement this with the host app's authenticated backend client.
        // Capture this account's authentication context, not a mutable global user.
        try await authenticatedBackend.collectorToken()
    }
)
try await analytics.track("app_opened")
try await analytics.track("feature_used", properties: ["feature": .choice("search")])
```

The example's `authenticatedAnalyticsSubject`, `memberAllowsUsageAnalytics` and
`authenticatedBackend` are supplied by your application. A subject must match
`[A-Za-z0-9_-]{8,128}`. Use an opaque random or backend-derived identifier; names,
email addresses and other direct identifiers do not belong here.

The SDK defaults to disabled. Tracking while disabled returns `nil`, performs no
network request, and writes no events. Definitions must also be configured on the
server: the client allowlist does not replace server validation.

For token response decoding, use a `JSONDecoder` strategy that accepts ISO8601
timestamps with fractional seconds. `CollectorToken` is `Codable`; the SDK does
not fetch or persist tokens itself. The provider is invoked immediately before
each flush, and subject, environment and expiry are checked before sending.

## Account and collection changes

```swift
try await analytics.setEnabled(false) // Stop, cancel in-flight work and erase pending events.
try await analytics.signOut()         // Same collection boundary at sign-out.
try await analytics.setIdentity(newSubject, enabled: newMemberAllowsAnalytics) {
    try await newAccountBackend.collectorToken()
}
```

Changing identity discards the old account's queue, creates a new session, cancels
the old request and ignores its late result. The new account defaults to disabled
unless you explicitly pass its own analytics choice. A request already accepted
by the server cannot be recalled by cancelling it; use the service's data lifecycle
controls for already stored events. There is no anonymous identity merging.

## Delivery and storage behavior

- Events use stable UUIDs, UTC timestamps and a session UUID. Sessions rotate on
  identity changes, explicit `startSession()`, or 30 minutes of inactivity.
- The queue is persisted atomically before `track` returns. It is scoped by a hash
  of API origin, app namespace, environment and identity. Queue files contain no
  token or raw subject; use a dedicated SDK directory.
- The default bound is 500 events, configurable from 1 to 500. Adding beyond the
  bound drops the oldest pending event. Entries expire after seven days. Removing
  an event definition also prevents its old cached events from being sent.
- Properties support booleans, bounded integers and fixed string choices. Arbitrary
  text, URLs, nested JSON and undeclared properties are rejected before persistence.
- Automatic mode batches after one second, up to 50 events and 60 KiB per request,
  then drains remaining batches. Restarting resumes a persisted queue.
- Network failures, `408`, `429` and `5xx` retain IDs and retry with exponential
  backoff, capped at one hour. Numeric `Retry-After` is respected up to that cap.
  Other `4xx` responses discard that rejected batch so a permanently invalid
  event cannot block the queue. Explicit `flush()` reports the discarded count.
- A `200` only removes events when `accepted + duplicates` equals the batch size.
  Malformed acknowledgments and `202` keep events pending. This is analytics
  delivery acknowledgment, not a purchase or entitlement system.
- HTTPS is required. Explicit `allowsLocalhostHTTP` permits HTTP only for localhost
  in the development environment. Redirects are refused. The URL session uses no
  cookie store, URL cache or persisted credentials.
- iOS queue files use file protection and are excluded from backup. No background
  execution entitlement is required or claimed. When the OS suspends the app,
  delivery resumes when it runs again. `flush()` may be called on foregrounding.

Set `automaticFlush: false` for deterministic tests or explicit flushing. Inspect
`pendingEventCount` and the returned `FlushResult` without logging raw event bodies
or credentials.

## Tests

Run `swift test` at the repository root. Tests cover account switches during token
fetch and HTTP delivery, opt-out, queue restart and expiry, no-identity leakage,
idempotent retry, automatic retries, batch limits, schema validation, TLS policy,
and token subject/environment mismatches.

The generic package contains synthetic fixtures only. App-specific integration
code belongs to the consuming app's repository.
