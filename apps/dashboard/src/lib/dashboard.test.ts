import { describe, expect, it, vi } from "vitest";
import { demoAnalytics } from "./demo";
import { githubPrincipal } from "./github";
import { allowlist, analyticsQuery, isAllowed, isDemo, parseFilters, percent } from "./policy";
import { analyticsSchema } from "./schema";

describe("dashboard access boundary", () => {
	it("cannot enable demo authentication bypass in production", () => {
		expect(isDemo({ NODE_ENV: "production", SUBKIT_DEMO: "true" })).toBe(false);
		expect(isDemo({ NODE_ENV: "development", SUBKIT_DEMO: "false" })).toBe(false);
		expect(isDemo({ NODE_ENV: "development", SUBKIT_DEMO: "true" })).toBe(true);
	});
	it("fails closed with an empty allowlist and rechecks an existing principal", () => {
		expect(isAllowed({ githubId: "123", verifiedEmail: "admin@example.test" }, allowlist({}))).toBe(
			false,
		);
		expect(
			isAllowed({ githubId: "123" }, allowlist({ SUBKIT_ALLOWED_GITHUB_IDS: "123, 456" })),
		).toBe(true);
		expect(isAllowed({ githubId: "123" }, allowlist({ SUBKIT_ALLOWED_GITHUB_IDS: "456" }))).toBe(
			false,
		);
	});
	it("rejects unverified email and does not treat a matching address as authentication", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify([{ email: "admin@example.test", verified: false }])),
			);
		expect(
			await githubPrincipal(
				"123",
				"test-oauth-token",
				{ ids: [], emails: ["admin@example.test"] },
				fetcher,
			),
		).toBeNull();
	});
	it("uses only the authenticated GitHub verified email endpoint", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify([{ email: "Admin@example.test", verified: true }])),
			);
		expect(
			await githubPrincipal(
				"123",
				"test-oauth-token",
				{ ids: [], emails: ["admin@example.test"] },
				fetcher,
			),
		).toEqual({ githubId: "123", verifiedEmail: "admin@example.test" });
		expect(fetcher).toHaveBeenCalledWith(
			"https://api.github.com/user/emails?per_page=100",
			expect.objectContaining({ redirect: "error", cache: "no-store" }),
		);
	});
	it("denies upstream failure and accepts stable GitHub IDs without an email lookup", async () => {
		const fetcher = vi.fn().mockRejectedValue(new Error("network"));
		expect(
			await githubPrincipal(
				"123",
				"test-token",
				{ ids: [], emails: ["admin@example.test"] },
				fetcher,
			),
		).toBeNull();
		fetcher.mockClear();
		expect(await githubPrincipal("123", undefined, { ids: ["123"], emails: [] }, fetcher)).toEqual({
			githubId: "123",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});
});

describe("usage views", () => {
	const now = new Date("2026-11-09T12:00:00Z");
	it("uses inclusive UTC dates and sanitizes unknown filter input", () => {
		expect(parseFilters({ range: "7", environment: "production" }, now)).toMatchObject({
			from: "2026-11-03",
			to: "2026-11-09",
			environment: "production",
		});
		expect(
			parseFilters({ range: "invalid", event: "../../", funnel: "a,b,c,d,e,f" }, now),
		).toMatchObject({ range: "30", event: undefined, funnel: [] });
	});
	it("requests all time without an accidental 30-day cutoff", () => {
		const query = analyticsQuery(
			parseFilters({ range: "all", funnel: "app_opened,project_created" }, now),
		);
		expect(query.get("range")).toBe("all");
		expect(query.has("from")).toBe(false);
		expect(query.get("funnel")).toBe("app_opened,project_created");
	});
	it("distinguishes an immature cohort from a mature zero", () => {
		expect(percent(null)).toBe("Not yet mature");
		expect(percent(0)).toBe("0%");
		expect(percent(0.375)).toBe("38%");
	});
	it("keeps synthetic fixture totals internally consistent with the shared domain model", () => {
		const data = demoAnalytics(
			parseFilters({ range: "30", funnel: "app_opened,project_created,project_shared" }, now),
			now,
		);
		expect(analyticsSchema.safeParse(data).success).toBe(true);
		expect(data.totals.events).toBe(data.daily.reduce((sum, day) => sum + day.events, 0));
		expect(data.totals.events).toBe(data.topEvents.reduce((sum, event) => sum + event.count, 0));
		const [first, second, third] = data.funnel;
		if (!first || !second || !third) throw new Error("Missing fixture funnel steps");
		expect(first.users).toBeGreaterThanOrEqual(second.users);
		expect(second.users).toBeGreaterThanOrEqual(third.users);
		expect(data.app.slug).toBe("demo-app");
	});
	it("validates bad API metrics rather than rendering them as plausible data", () => {
		const data = demoAnalytics(parseFilters({}, now), now);
		expect(
			analyticsSchema.safeParse({
				...data,
				totals: { ...data.totals, events: -1 },
			}).success,
		).toBe(false);
	});
});
