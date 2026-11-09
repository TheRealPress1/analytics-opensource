import type { Allowlist } from "./policy";

/** Only GitHub's authenticated email endpoint can supply a verified email. */
export async function githubPrincipal(
	githubId: string,
	accessToken: string | undefined,
	list: Allowlist,
	fetcher: typeof fetch = fetch,
) {
	if (list.ids.includes(githubId)) return { githubId };
	if (!list.emails.length || !accessToken) return null;
	try {
		const response = await fetcher("https://api.github.com/user/emails?per_page=100", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2026-03-10",
			},
			cache: "no-store",
			redirect: "error",
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) return null;
		const emails: unknown = await response.json();
		if (!Array.isArray(emails)) return null;
		for (const entry of emails) {
			if (
				entry &&
				typeof entry === "object" &&
				entry.verified === true &&
				typeof entry.email === "string" &&
				list.emails.includes(entry.email.toLowerCase())
			) {
				return { githubId, verifiedEmail: entry.email.toLowerCase() as string };
			}
		}
		return null;
	} catch {
		return null;
	}
}
