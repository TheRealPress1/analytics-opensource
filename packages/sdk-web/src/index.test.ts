import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AnalyticsClient,
	AnalyticsError,
	type AnalyticsOptions,
	type CollectorToken,
	memoryQueueStorage,
} from "./index.js";

const now = Date.parse("2026-11-09T12:00:00.000Z");
const subjectA = "synthetic_user_a";
const subjectB = "synthetic_user_b";
const token = (subject = subjectA): CollectorToken => ({
	token: "synthetic.collector.token",
	subject,
	environment: "development",
	expiresAt: new Date(now + 3600_000).toISOString(),
});
const response = (accepted: number, duplicates = 0) => Response.json({ accepted, duplicates });
const clients: AnalyticsClient[] = [];
async function create(overrides: Partial<AnalyticsOptions> = {}) {
	const client = await AnalyticsClient.create({
		baseUrl: "https://analytics.example.test",
		appNamespace: "synthetic-app",
		subject: subjectA,
		environment: "development",
		eventSpecs: {
			app_opened: {},
			feature_used: {
				feature: { type: "enum", values: ["search", "favorites"] },
				success: { type: "boolean" },
			},
		},
		tokenProvider: async () => token(),
		enabled: true,
		automaticFlush: false,
		now: () => now,
		...overrides,
	});
	clients.push(client);
	return client;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((value) => {
		resolve = value;
	});
	return { promise, resolve };
}
afterEach(() => {
	for (const client of clients) client.dispose();
	clients.length = 0;
	vi.useRealTimers();
});

describe("browser usage SDK", () => {
	it("does not record or transmit without explicit enablement", async () => {
		const fetcher = vi.fn();
		const client = await create({ enabled: false, fetch: fetcher });
		expect(client.track("app_opened")).toBeUndefined();
		expect(await client.flush()).toEqual({ accepted: 0, duplicates: 0, discarded: 0 });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects undeclared event names, arbitrary text and undeclared properties", async () => {
		const client = await create();
		expect(() => client.track("email_changed")).toThrow(AnalyticsError);
		expect(() => client.track("feature_used", { email: "person@example.test" })).toThrow(
			AnalyticsError,
		);
		expect(() => client.track("feature_used", { feature: "free text" })).toThrow(AnalyticsError);
		expect(client.pendingEventCount).toBe(0);
	});

	it("retries identical events and acknowledges duplicates", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("", { status: 503 }))
			.mockResolvedValueOnce(response(0, 1));
		const client = await create({ fetch: fetcher });
		const id = client.track("app_opened");
		await expect(client.flush()).rejects.toMatchObject({ status: 503 });
		expect(client.pendingEventCount).toBe(1);
		expect(await client.flush()).toEqual({ accepted: 0, duplicates: 1, discarded: 0 });
		expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
		expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).events[0].id).toBe(id);
		expect(fetcher.mock.calls[1]?.[1]?.redirect).toBe("error");
		expect(fetcher.mock.calls[1]?.[1]?.credentials).toBe("omit");
	});

	it("keeps events pending for incomplete acknowledgment or 202", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(0))
			.mockResolvedValueOnce(new Response("", { status: 202 }));
		const client = await create({ fetch: fetcher });
		client.track("app_opened");
		await expect(client.flush()).rejects.toMatchObject({ code: "invalid_acknowledgment" });
		await expect(client.flush()).rejects.toMatchObject({ status: 202 });
		expect(client.pendingEventCount).toBe(1);
	});

	it("reports a permanent validation rejection without blocking later events", async () => {
		const client = await create({
			fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 400 })),
		});
		client.track("app_opened");
		expect((await client.flush()).discarded).toBe(1);
		expect(client.pendingEventCount).toBe(0);
	});

	it("bounds queue size and sends batches of at most fifty", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(50))
			.mockResolvedValueOnce(response(10));
		const client = await create({ fetch: fetcher, maxQueuedEvents: 60 });
		const ids = Array.from({ length: 70 }, () => client.track("app_opened"));
		expect(client.pendingEventCount).toBe(60);
		await client.flush();
		expect(client.pendingEventCount).toBe(10);
		await client.flush();
		const first = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).events;
		expect(first).toHaveLength(50);
		expect(first[0].id).toBe(ids[10]);
	});

	it("persists scoped events across launch without saving subjects or tokens", async () => {
		const values = new Map<string, string>();
		const storage = {
			read: (key: string) => values.get(key) ?? null,
			write: (key: string, value: string) => {
				values.set(key, value);
			},
			remove: (key: string) => {
				values.delete(key);
			},
		};
		const first = await create({ storage });
		first.track("app_opened");
		first.dispose();
		const resumed = await create({ storage });
		expect(resumed.pendingEventCount).toBe(1);
		const other = await create({
			storage,
			subject: subjectB,
			tokenProvider: async () => token(subjectB),
		});
		expect(other.pendingEventCount).toBe(0);
		expect(JSON.stringify([...values])).not.toContain(subjectA);
		expect(JSON.stringify([...values])).not.toContain("synthetic.collector.token");
	});

	it("expires persisted events at seven days and clears on opt-out", async () => {
		const storage = memoryQueueStorage();
		const first = await create({ storage });
		first.track("app_opened");
		first.dispose();
		const resumed = await create({ storage, now: () => now + 7 * 86_400_000 });
		expect(resumed.pendingEventCount).toBe(0);
		resumed.track("app_opened");
		resumed.setEnabled(false);
		expect(resumed.pendingEventCount).toBe(0);
		expect(resumed.track("app_opened")).toBeUndefined();
	});

	it("fences a late token result when switching accounts", async () => {
		const gate = deferred<CollectorToken>();
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(1));
		const client = await create({ fetch: fetcher, tokenProvider: async () => gate.promise });
		client.track("app_opened");
		const old = client.flush();
		await client.setIdentity(subjectB, async () => token(subjectB), true);
		client.track("app_opened");
		gate.resolve(token());
		expect((await old).superseded).toBe(true);
		expect(fetcher).not.toHaveBeenCalled();
		expect(client.pendingEventCount).toBe(1);
		expect((await client.flush()).accepted).toBe(1);
	});

	it("fences a late HTTP result and aborts the old request", async () => {
		const gate = deferred<Response>();
		const started = deferred<void>();
		let signal: AbortSignal | null | undefined;
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
			signal = options?.signal;
			started.resolve();
			return gate.promise;
		});
		const client = await create({ fetch: fetcher });
		client.track("app_opened");
		const old = client.flush();
		await started.promise;
		await client.setIdentity(subjectB, async () => token(subjectB), true);
		client.track("app_opened");
		gate.resolve(response(1));
		expect((await old).superseded).toBe(true);
		expect(signal?.aborted).toBe(true);
		expect(client.pendingEventCount).toBe(1);
	});

	it("resets consent and session when identity changes", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async (_url, options) =>
				response(JSON.parse(String(options?.body)).events.length),
			);
		const client = await create({ fetch: fetcher });
		client.track("app_opened");
		await client.flush();
		await client.setIdentity(subjectB, async () => token(subjectB));
		expect(client.isEnabled).toBe(false);
		client.setEnabled(true);
		client.track("app_opened");
		await client.flush();
		const first = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).events[0];
		const second = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).events[0];
		expect(first.sessionId).not.toBe(second.sessionId);
	});

	it("rejects mismatched identity, environment, expired tokens and server keys", async () => {
		for (const credential of [
			token(subjectB),
			{ ...token(), environment: "production" as const },
			{ ...token(), expiresAt: new Date(now).toISOString() },
			{ ...token(), token: "sk_never_put_this_in_browser" },
		]) {
			const fetcher = vi.fn();
			const client = await create({ fetch: fetcher, tokenProvider: async () => credential });
			client.track("app_opened");
			await expect(client.flush()).rejects.toBeInstanceOf(AnalyticsError);
			expect(fetcher).not.toHaveBeenCalled();
		}
	});

	it("allows HTTP only for explicitly enabled localhost development", async () => {
		for (const options of [
			{ baseUrl: "http://example.test", allowLocalhostHttp: true },
			{ baseUrl: "http://localhost:8080" },
			{
				baseUrl: "http://localhost:8080",
				allowLocalhostHttp: true,
				environment: "production" as const,
			},
		]) {
			await expect(create(options)).rejects.toMatchObject({ code: "invalid_api_origin" });
		}
		await expect(
			create({ baseUrl: "http://localhost:8080", allowLocalhostHttp: true }),
		).resolves.toBeInstanceOf(AnalyticsClient);
	});

	it("automatically retries after a transient failure without another event", async () => {
		vi.useFakeTimers();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("", { status: 503 }))
			.mockResolvedValueOnce(response(1));
		const client = await create({ fetch: fetcher, automaticFlush: true });
		client.track("app_opened");
		await expect(client.flush()).rejects.toMatchObject({ status: 503 });
		await vi.advanceTimersByTimeAsync(2000);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(client.pendingEventCount).toBe(0);
	});

	it("keeps events after401 and fetches a fresh credential on automatic retry", async () => {
		vi.useFakeTimers();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("", { status: 401 }))
			.mockResolvedValueOnce(response(1));
		const tokenProvider = vi
			.fn()
			.mockResolvedValueOnce({ ...token(), token: "synthetic.collector.first" })
			.mockResolvedValueOnce({ ...token(), token: "synthetic.collector.fresh" });
		const client = await create({ fetch: fetcher, tokenProvider, automaticFlush: true });
		const id = client.track("app_opened");
		await expect(client.flush()).rejects.toMatchObject({ status: 401 });
		expect(client.pendingEventCount).toBe(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(tokenProvider).toHaveBeenCalledTimes(2);
		expect(client.pendingEventCount).toBe(0);
		expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
		expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).events[0].id).toBe(id);
		expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
			"Bearer synthetic.collector.first",
		);
		expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
			"Bearer synthetic.collector.fresh",
		);
	});
});
