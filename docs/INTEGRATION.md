# Install usage analytics in another app

1. Deploy the service following the [GCP bootstrap](../infra/gcp/README.md), or run it locally with PostgreSQL 16.
2. Write an app configuration using [the synthetic example](../examples/app-config.json). Choose a unique slug, a small event vocabulary and explicit property schemas. Register exact browser origins; native clients do not need them.
3. Run `pnpm app:create config.json /private/path/app-key.json` under the database provisioning identity. Save the resulting `sk_` key in your backend's secret store. The API stores only its hash. Never embed it in the app or browser.
4. Add a host-backend route that authenticates the current account, checks their analytics choice, and derives an opaque stable analytics subject. Use `SubKitServer.issueCollectorToken(subject, environment)` and return the token only to that user. Never accept the subject or environment directly from an untrusted request.
5. Install the [Swift SDK](IOS.md) or [browser SDK](../packages/sdk-web/README.md). Keep collection disabled until the host application's analytics choice allows it. Declare the same event/property schema as the server and provide the token callback.
6. Record named events after successful actions. Call the account switch, sign-out and disable boundaries as the corresponding host state changes. Use a separate development environment for tests.
7. Configure [the dashboard](DASHBOARD.md) with the app's server key, API URL and GitHub allowlist. These credentials stay in Vercel's server-side configuration.

## A host backend example

```ts
import { SubKitServer } from "@subkit/server";

const analytics = new SubKitServer({
	baseUrl: "https://YOUR_API.run.app",
	secretKey: await readSecretFromYourSecretStore(),
});

async function collectorSession(request: Request) {
	const account = await authenticateYourOwnAccount(request);
	if (!account?.analyticsEnabled) return new Response(null, { status: 403 });
	// This identifier is assigned on the server. It contains no email/name.
	const session = await analytics.issueCollectorToken(account.analyticsSubject, "production");
	return Response.json(session, { headers: { "Cache-Control": "no-store" } });
}
```

Authentication and consent functions above belong to the host application; this service does not infer them. Apply your normal CSRF/session protections to that route. A collector token lasts 15 minutes and grants only ingestion for its bound app, subject and environment.

All SDKs accept an API mount prefix, for example `https://example.com/api/app-analytics`. They append `/v1/events` or `/v1/server/...` on that same origin; do not include `/v1` in the configured base URL. A single trailing slash is normalized. Path segments may contain ASCII letters, digits, `-`, `_`, `.`, and `~`, but not `.` or `..` alone. Encoded paths, repeated slashes, user information, queries and fragments are rejected. Redirects never forward credentials. An embedded host must route bearer-authenticated collector requests and browser preflights to the library without requiring a staff session; its dashboard and token-issuance boundary still need their own authorization.

## Installing from a release or checkout

Swift Package Manager installs directly from `https://github.com/TheRealPress1/analytics-opensource.git`. Pin an exact release tag or commit for reproducibility. The product is `SubKitAnalytics`; the package has no third-party Swift dependencies.

The JavaScript packages have no runtime dependencies and can be installed from release `.tgz` assets. For a local checkout:

```sh
pnpm install
pnpm --dir packages/sdk-web pack --pack-destination ../../artifacts
pnpm --dir packages/sdk-server pack --pack-destination ../../artifacts
# In your separate consumer project:
pnpm add /absolute/path/to/artifacts/subkit-web-0.2.0.tgz
```

Install `subkit-server-0.2.0.tgz` in the authenticated backend. These instructions do not imply that an npm package has been published.

## Verify the integration

Use a synthetic subject in development. Emit one event, retry that exact event ID, then confirm that the event count increased once. Switch accounts while a delivery is pending and confirm that the old request cannot send or remove the new user's queue. Disable collection and confirm pending events are removed. Verify that a development event never appears under production and that a second app's key cannot read the first app's events.

The Geneva repository contains a separate development pilot using the same SDK package and four property-free synthetic events. No Geneva-specific code or account data is needed to install this repository in another app.

## Deletion and key rotation

On an authorized host-account erasure, call `deleteSubject(subject)` server-side and clear the SDK. The service removes stored events and tombstones that identity, so still-valid collector tokens cannot repopulate it. Future opt-in must use a newly assigned opaque subject.

Server key provisioning currently uses the create-app CLI; a full key-rotation UI is not implemented. Rotate an app key with an authorized database operation updating only `secret_key_hash`, then update the host backend and dashboard secret configuration. Coordinate that change because the first version has one server key per app. Collector-signing secret changes invalidate outstanding tokens; SDK callbacks request fresh tokens on retry. Neither rotation is claimed to have a zero-downtime overlap mechanism in this usage-only release.
