# @subkit/server

Server-only, zero-dependency client for usage analytics. Requires Node 22+ or an
equivalent server runtime with `fetch` and `AbortController`. Never import this
package into a client component or embed its `sk_` key in an app.

Build with `pnpm --filter @subkit/server build`, then package with
`pnpm --filter @subkit/server pack`. Install the resulting reviewed `.tgz` directly
or distribute it as a GitHub release asset.

```ts
import { SubKitServer } from "@subkit/server";

const analytics = new SubKitServer({
	baseUrl: "https://analytics.example.com",
	secretKey: await readAppKeyFromYourSecretStore(),
});

// Authenticate your own request first. Derive this subject from the authenticated
// account, never from a subject supplied by the requesting phone/browser.
const session = await analytics.issueCollectorToken(authenticatedSubject, "production");

const overview = await analytics.getAnalytics({
	environment: "production",
	range: "all",
	funnel: ["app_opened", "onboarding_completed"],
});
const app = await analytics.getApp();
```

`issueCollectorToken()` returns a credential bound to the requested subject and
environment. Return it only to its authenticated owner. Reads and session creation
are isolated to the app owning the server key. This SDK never writes events as a
server-key holder or treats the key as a client identity.

`deleteSubject(subject)` deletes that subject's stored events across the app's
environments and tombstones the identity, preventing further collector sessions.
Your application's authenticated deletion workflow should call this intentionally;
it is not a reversible reset operation. A future analytics opt-in needs a newly
issued opaque subject according to your data lifecycle policy.

All methods accept an optional `AbortSignal`. Requests have a 15-second timeout,
disable redirects and caching, and return errors containing only a stable code and
HTTP status. Error messages omit response bodies and credentials. HTTPS is required;
`allowLocalhostHttp: true` is an explicit localhost development override.

Use `pnpm exec vitest run packages/sdk-server/src/index.test.ts` for its tests.
