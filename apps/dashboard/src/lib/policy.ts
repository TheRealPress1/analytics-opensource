export interface Allowlist {
	ids: string[];
	emails: string[];
}
export type Environment = "development" | "production";
export const ranges = ["today", "7", "30", "90", "all"] as const;
export type Range = (typeof ranges)[number];
export type SearchParams = Record<string, string | string[] | undefined>;

export function isDemo(env: Record<string, string | undefined>): boolean {
	return env.SUBKIT_DEMO === "true" && env.NODE_ENV !== "production";
}
export function allowlist(env: Record<string, string | undefined>): Allowlist {
	return {
		ids: (env.SUBKIT_ALLOWED_GITHUB_IDS ?? "")
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean),
		emails: (env.SUBKIT_ALLOWED_EMAILS ?? "")
			.split(",")
			.map((v) => v.trim().toLowerCase())
			.filter(Boolean),
	};
}
export function isAllowed(
	identity: { githubId?: string; verifiedEmail?: string },
	list: Allowlist,
): boolean {
	return (
		(!!identity.githubId && list.ids.includes(identity.githubId)) ||
		(!!identity.verifiedEmail && list.emails.includes(identity.verifiedEmail.toLowerCase()))
	);
}
export function single(value: string | string[] | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}
export function parseFilters(params: SearchParams, now = new Date()) {
	const value = single(params.range);
	const range: Range = ranges.includes(value as Range) ? (value as Range) : "30";
	const environment: Environment =
		single(params.environment) === "production" ? "production" : "development";
	const to = now.toISOString().slice(0, 10);
	const days = range === "today" ? 1 : range === "all" ? 30 : Number(range);
	const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86400000)
		.toISOString()
		.slice(0, 10);
	const namePattern = /^[a-z][a-z0-9_]{0,63}$/;
	const event = single(params.event);
	const funnel = (single(params.funnel) ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
	return {
		range,
		environment,
		from,
		to,
		event: event && namePattern.test(event) ? event : undefined,
		funnel:
			funnel.length >= 2 && funnel.length <= 5 && funnel.every((v) => namePattern.test(v))
				? funnel
				: [],
	};
}
export type Filters = ReturnType<typeof parseFilters>;
export function analyticsQuery(filters: Filters): URLSearchParams {
	const query = new URLSearchParams({ environment: filters.environment });
	if (filters.range === "all") query.set("range", "all");
	else {
		query.set("from", filters.from);
		query.set("to", filters.to);
	}
	if (filters.event) query.set("event", filters.event);
	if (filters.funnel.length) query.set("funnel", filters.funnel.join(","));
	return query;
}
export function percent(value: number | null): string {
	return value === null ? "Not yet mature" : `${Math.round(value * 100)}%`;
}
