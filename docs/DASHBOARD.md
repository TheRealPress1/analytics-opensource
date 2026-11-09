# Usage dashboard

The Next.js dashboard shows recorded events, active people, sessions, daily activity, feature use, sequential funnels, and exact-day retention. It reads the API's app-scoped server endpoints. It has no database connection or database credentials. Billing and subscriptions are out of scope.

## Local synthetic preview

From the repository root:

```sh
pnpm install
pnpm --filter @subkit/core build
SUBKIT_DEMO=true pnpm --filter @subkit/dashboard dev
```

Open http://localhost:3100. The banner explicitly labels every event and person as fictional. The fixture uses the same domain calculation as the API, respects the selected filters, and never calls the real API. `SUBKIT_DEMO=true` is ignored whenever `NODE_ENV=production`, including Vercel preview and production builds. No live Geneva data belongs in this preview or this repository.

## Connect real applications

Set these **server-side** variables in Vercel's encrypted environment variable settings (or local `.env.local`). Never use `NEXT_PUBLIC_` for any of them.

| Variable                               | Purpose                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `SUBKIT_API_URL`                       | HTTPS URL of the Cloud Run API. Local development alone allows loopback HTTP.                                                  |
| `SUBKIT_APPS_JSON`                     | Array of `{name, slug, apiKey}` for permitted apps. Each `apiKey` is that app's `sk_` server key.                              |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | Credentials of a GitHub OAuth app.                                                                                             |
| `AUTH_SECRET`                          | At least 32 cryptographically random characters; generate with `pnpm exec auth secret`.                                        |
| `AUTH_URL`                             | Canonical dashboard URL when required by the deployment.                                                                       |
| `SUBKIT_ALLOWED_GITHUB_IDS`            | Comma-separated immutable GitHub numeric account IDs. Prefer this over email.                                                  |
| `SUBKIT_ALLOWED_EMAILS`                | Optional comma-separated email allowlist. Only verified addresses from GitHub's authenticated `/user/emails` endpoint qualify. |

Configure the GitHub OAuth callback as `https://your-dashboard.example.com/api/auth/callback/github`. OAuth scope is `read:user user:email`. Unknown accounts, empty allowlists, unverified emails, failed GitHub lookups, and existing sessions removed from the allowlist are denied. Sessions expire after eight hours. Changing the allowlist revokes dashboard access on the next request. App keys remain only in server components; client filter controls receive app names and slugs, and charts receive aggregate analytics. No API proxy route exposes server keys or server endpoint access to the browser. Missing configuration yields a setup screen rather than an unauthenticated dashboard.

The API should use its own authorization on every server request. Cloud Run must permit the dashboard to reach its HTTPS endpoint; the per-app `sk_` key authorizes app data. Dashboard requests never follow redirects, are uncached, and validate the returned app slug, environment, and response structure before rendering. Authentication on Vercel does not substitute for API authorization.

## Vercel project

Import the standalone repository. Set the project root to `apps/dashboard`, framework to Next.js, and enable access to files outside the root directory. Use `pnpm install --frozen-lockfile` for installation and `pnpm --filter @subkit/core build && pnpm --filter @subkit/dashboard build` from the repository root (or the equivalent monorepo build command configured in Vercel). The API stays on Google Cloud. No runtime secrets are baked into a container or committed to Git.

Vercel stores its Auth.js and application API secrets; Cloud Run runtime secrets follow the Secret Manager file-mount setup in `RUNBOOK.md`. Use distinct OAuth apps/credentials and server keys for staging and production. Production is never a synthetic-demo deployment.

## Metric and filter behavior

- Today, 7/30/90 days and all time use inclusive UTC dates. Event and environment filters apply consistently across displayed metrics.
- Daily values are exact event counts, distinct subjects, and distinct `(subject, sessionId)` sessions. The accessible daily data table provides chart values.
- Active today, active in seven days, and active in thirty days are anchored to the current UTC day, independent of the selected historical chart range.
- Retention cohorts start on the person's first observed event. Day 1/7/30 means a return on that exact UTC date. A patterned dash means the full return day has not elapsed; a mature zero is displayed as `0%`.
- Funnel steps must occur in order at strictly increasing timestamps within the selected range. Each step's percentage is relative to the preceding step. People can complete across sessions. The form supports two to five named steps.
- Empty or unavailable data remains empty or visibly unavailable. The dashboard never substitutes demo values when the API fails.

## Validation

`pnpm --filter @subkit/dashboard typecheck`, `pnpm --filter @subkit/dashboard build`, and the root Vitest suite cover the dashboard. Dashboard tests check production demo denial, allowlist revocation, verified email handling, upstream auth failures, all-time queries, UTC boundaries, immature retention, response validation, and synthetic metric consistency. A successful build does not establish that Vercel OAuth or a real Cloud Run API has been deployed; validate those separately after configuration.

Official references: [Auth.js installation](https://authjs.dev/getting-started/installation), [GitHub provider](https://authjs.dev/getting-started/providers/github), [deployment variables](https://authjs.dev/getting-started/deployment), [GitHub verified email API](https://docs.github.com/en/rest/users/emails#list-email-addresses-for-the-authenticated-user).
