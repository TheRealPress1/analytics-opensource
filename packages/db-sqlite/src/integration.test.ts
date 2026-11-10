import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createApi } from "@subkit/api";
import { type App, ConflictError } from "@subkit/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateSQLite, SQLiteRepository } from "./index.js";

const key = "sk_synthetic_sqlite_fixture_123456789";
const now = new Date("2026-11-10T12:00:00Z");
const subject = "opaque_fixture_1";
const event = () => ({
	id: randomUUID(),
	name: "app_opened",
	sessionId: randomUUID(),
	occurredAt: now.toISOString(),
	properties: {},
});
const input = {
	name: "Synthetic",
	slug: "synthetic",
	eventSpecs: { app_opened: {} },
	allowedOrigins: ["https://fixture.example"],
};
let directory: string, path: string, db: Database.Database, repo: SQLiteRepository, owner: App;
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "subkit-sqlite-"));
	path = join(directory, "host.db");
	db = new Database(path);
	db.exec(
		"CREATE TABLE host_records(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO host_records VALUES(1,'synthetic host row')",
	);
	migrateSQLite(db);
	repo = new SQLiteRepository(db);
	owner = await repo.createApp(input, key);
});
afterEach(() => {
	if (db?.open) db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("borrowed SQLite database", () => {
	it("migrates twice without changing the host schema, rows, PRAGMAs, or connection", async () => {
		const pragmas = [
			"journal_mode",
			"foreign_keys",
			"busy_timeout",
			"synchronous",
			"user_version",
		].map((name) => db.pragma(name, { simple: true }));
		const hostSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='host_records'").get();
		migrateSQLite(db);
		await repo.health();
		expect(
			["journal_mode", "foreign_keys", "busy_timeout", "synchronous", "user_version"].map((name) =>
				db.pragma(name, { simple: true }),
			),
		).toEqual(pragmas);
		expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='host_records'").get()).toEqual(
			hostSchema,
		);
		expect(db.prepare("SELECT * FROM host_records").all()).toEqual([
			{ id: 1, value: "synthetic host row" },
		]);
		expect(db.open).toBe(true);
		expect(db.inTransaction).toBe(false);
		expect(db.prepare("SELECT count(*) AS count FROM subkit_analytics_migrations").get()).toEqual({
			count: 1,
		});
		expect(await repo.appBySlug(input.slug)).toEqual(owner);
		expect(await repo.listApps()).toEqual([owner]);
	});
	it("does not migrate on construction and fails readiness on an unmigrated handle", async () => {
		const fresh = new Database(":memory:");
		try {
			const adapter = new SQLiteRepository(fresh);
			await expect(adapter.health()).rejects.toThrow();
			expect(fresh.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
		} finally {
			fresh.close();
		}
	});
	it("rejects a changed migration checksum without touching host data", () => {
		db.prepare("UPDATE subkit_analytics_migrations SET checksum='changed'").run();
		expect(() => migrateSQLite(db)).toThrow("Applied analytics migration changed");
		expect(db.prepare("SELECT value FROM host_records").get()).toEqual({
			value: "synthetic host row",
		});
	});
	it("refuses an existing analytics table collision and rolls back its migration table", () => {
		const fresh = new Database(":memory:");
		try {
			fresh.exec("CREATE TABLE subkit_analytics_events(host_value TEXT)");
			expect(() => migrateSQLite(fresh)).toThrow();
			expect(fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
				{ name: "subkit_analytics_events" },
			]);
		} finally {
			fresh.close();
		}
	});
	it("deduplicates retries and rolls back a mixed batch when any event conflicts", async () => {
		const original = event(),
			another = event();
		expect(await repo.ingest(owner.id, subject, "development", [original])).toEqual({
			accepted: 1,
			duplicates: 0,
		});
		expect(await repo.ingest(owner.id, subject, "development", [original])).toEqual({
			accepted: 0,
			duplicates: 1,
		});
		await expect(
			repo.ingest(owner.id, subject, "development", [
				another,
				{ ...original, sessionId: randomUUID() },
			]),
		).rejects.toBeInstanceOf(ConflictError);
		expect((await repo.history(owner.id, "development")).length).toBe(1);
		await expect(
			repo.ingest(owner.id, "other_subject", "development", [original]),
		).rejects.toBeInstanceOf(ConflictError);
	});
	it("scopes identical IDs by app/environment and tombstones the subject across environments", async () => {
		const other = await repo.createApp({ ...input, slug: "other" }, `${key}_other`),
			item = event();
		for (const env of ["production", "development"] as const)
			await repo.ingest(owner.id, subject, env, [item]);
		await repo.ingest(other.id, subject, "development", [item]);
		expect(await repo.deleteSubject(owner.id, subject)).toBe(2);
		expect(await repo.isSubjectDeleted(owner.id, subject)).toBe(true);
		expect(await repo.isSubjectDeleted(other.id, subject)).toBe(false);
		await expect(repo.ingest(owner.id, subject, "production", [event()])).rejects.toBeInstanceOf(
			ConflictError,
		);
		expect(await repo.history(other.id, "development")).toHaveLength(1);
	});
	it("uses atomic rate windows and bounded cleanup without deleting history", async () => {
		for (let i = 0; i < 3; i++) expect(await repo.consumeRate("fixture", 2, now)).toBe(i < 2);
		const later = new Date(now.getTime() + 60000);
		expect(await repo.consumeRate("fixture", 2, later)).toBe(true);
		for (let i = 0; i < 4; i++) await repo.consumeRate(`old_${i}`, 10, now);
		await repo.ingest(owner.id, subject, "development", [event()]);
		expect(await repo.cleanupRateLimits({ before: later, limit: 2 })).toBe(2);
		expect(db.prepare("SELECT count(*) AS count FROM subkit_analytics_rate_limits").get()).toEqual({
			count: 3,
		});
		expect(await repo.history(owner.id, "development")).toHaveLength(1);
		await expect(repo.cleanupRateLimits({ before: later, limit: 10001 })).rejects.toThrow();
	});
});

function startContender(action: "ingest" | "delete", item: ReturnType<typeof event>) {
	const worker = new Worker(new URL("./race-worker.mjs", import.meta.url), {
		workerData: { path, appId: owner.id, subject, event: item, action },
	});
	let resolveAttempt!: () => void;
	const attempting = new Promise<void>((resolve) => {
		resolveAttempt = resolve;
	});
	const result = new Promise<{ value?: unknown; error?: string }>((resolve, reject) => {
		worker.on("error", reject);
		worker.on("message", (message) => {
			if (message.kind === "blocked") resolveAttempt();
			else resolve(message);
		});
	});
	const exited = new Promise<number>((resolve) => worker.on("exit", resolve));
	return { attempting, result, exited, resume: () => worker.postMessage("retry") };
}
describe("two-connection deletion serialization", () => {
	it("rejects ingestion waiting behind an uncommitted deletion tombstone", async () => {
		await repo.ingest(owner.id, subject, "development", [event()]);
		db.exec("BEGIN IMMEDIATE");
		try {
			await repo.deleteSubject(owner.id, subject);
			const contender = startContender("ingest", event());
			await contender.attempting;
			db.exec("COMMIT");
			contender.resume();
			expect(await contender.result).toMatchObject({ error: "ConflictError" });
			expect(await contender.exited).toBe(0);
			expect(await repo.history(owner.id, "development")).toEqual([]);
		} finally {
			if (db.inTransaction) db.exec("ROLLBACK");
		}
	});
	it("deletion waiting behind ingestion removes the committed event and fences retries", async () => {
		const item = event();
		db.exec("BEGIN IMMEDIATE");
		try {
			await repo.ingest(owner.id, subject, "development", [item]);
			const contender = startContender("delete", item);
			await contender.attempting;
			db.exec("COMMIT");
			contender.resume();
			expect(await contender.result).toMatchObject({ value: 1 });
			expect(await contender.exited).toBe(0);
			expect(await repo.history(owner.id, "development")).toEqual([]);
			await expect(repo.ingest(owner.id, subject, "development", [item])).rejects.toBeInstanceOf(
				ConflictError,
			);
		} finally {
			if (db.inTransaction) db.exec("ROLLBACK");
		}
	});
});

describe("embedded HTTP API with SQLite", () => {
	it("enforces keys/tokens, origins, privacy validation, isolation, analytics, and deletion", async () => {
		const api = createApi({ repo, tokenSecret: new Uint8Array(32).fill(7), now: () => now });
		const auth = (value: string) => ({
			Authorization: `Bearer ${value}`,
			"Content-Type": "application/json",
		});
		expect((await api.request("/readyz")).status).toBe(200);
		expect((await api.request("/v1/server/analytics")).status).toBe(401);
		expect(
			(
				await api.request("/v1/events", {
					method: "POST",
					headers: auth(key),
					body: JSON.stringify({ events: [event()] }),
				})
			).status,
		).toBe(401);
		const session = await api.request("/v1/server/sessions", {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({ subject, environment: "development" }),
		});
		expect(session.status).toBe(200);
		const { token } = await session.json();
		const item = event();
		const send = (body: unknown, origin = "https://fixture.example") =>
			api.request("/v1/events", {
				method: "POST",
				headers: { ...auth(token), Origin: origin },
				body: JSON.stringify(body),
			});
		expect((await send({ events: [item] }, "https://untrusted.example")).status).toBe(403);
		expect(
			(await send({ events: [{ ...item, properties: { email: "private@example.com" } }] })).status,
		).toBe(400);
		const accepted = await send({ events: [item] });
		expect(accepted.status).toBe(200);
		expect(await accepted.json()).toEqual({ accepted: 1, duplicates: 0 });
		expect(await (await send({ events: [item] })).json()).toEqual({ accepted: 0, duplicates: 1 });
		expect((await send({ events: [{ ...item, sessionId: randomUUID() }] })).status).toBe(409);
		const analytics = await api.request("/v1/server/analytics?environment=development&range=all", {
			headers: auth(key),
		});
		expect(analytics.status).toBe(200);
		expect((await analytics.json()).totals.events).toBe(1);
		const production = await api.request("/v1/server/analytics?environment=production", {
			headers: auth(key),
		});
		expect((await production.json()).totals.events).toBe(0);
		expect(
			(
				await api.request(`/v1/server/subjects/${subject}`, {
					method: "DELETE",
					headers: auth(key),
				})
			).status,
		).toBe(200);
		expect((await send({ events: [event()] })).status).toBe(410);
		expect(
			(
				await api.request("/v1/server/sessions", {
					method: "POST",
					headers: auth(key),
					body: JSON.stringify({ subject, environment: "development" }),
				})
			).status,
		).toBe(410);
	});
});

describe("shared-host API limits", () => {
	it("validates overrides and applies per-collector, session, and analytics limits", async () => {
		expect(() =>
			createApi({ repo, tokenSecret: new Uint8Array(32), limits: { sessions: 0 } }),
		).toThrow();
		expect(() =>
			createApi({ repo, tokenSecret: new Uint8Array(32), limits: { eventsPerApp: 1.5 } }),
		).toThrow();
		const api = createApi({
			repo,
			tokenSecret: new Uint8Array(32).fill(3),
			now: () => now,
			limits: { eventsPerApp: 10, eventsPerCollector: 1, sessions: 1, analytics: 1 },
		});
		const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
		const session = () =>
			api.request("/v1/server/sessions", {
				method: "POST",
				headers,
				body: JSON.stringify({ subject, environment: "development" }),
			});
		const first = await session();
		const { token } = await first.json();
		expect(first.status).toBe(200);
		expect((await session()).status).toBe(429);
		const send = () =>
			api.request("/v1/events", {
				method: "POST",
				headers: { ...headers, Authorization: `Bearer ${token}` },
				body: JSON.stringify({ events: [event()] }),
			});
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(429);
		expect((await api.request("/v1/server/analytics", { headers })).status).toBe(200);
		expect((await api.request("/v1/server/analytics", { headers })).status).toBe(429);
	});
	it("applies the app event limit across separate collector identities", async () => {
		const api = createApi({
			repo,
			tokenSecret: new Uint8Array(32).fill(4),
			now: () => now,
			limits: { eventsPerApp: 1, eventsPerCollector: 10 },
		});
		const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
		const send = async (identity: string) => {
			const response = await api.request("/v1/server/sessions", {
				method: "POST",
				headers,
				body: JSON.stringify({ subject: identity, environment: "development" }),
			});
			const { token } = await response.json();
			return api.request("/v1/events", {
				method: "POST",
				headers: { ...headers, Authorization: `Bearer ${token}` },
				body: JSON.stringify({ events: [event()] }),
			});
		};
		expect((await send("collector_first")).status).toBe(200);
		expect((await send("collector_second")).status).toBe(429);
	});
});

describe("PostgreSQL UUID parity", () => {
	it("normalizes mixed-case IDs for dedupe and session counts", async () => {
		const item = event();
		expect(
			await repo.ingest(owner.id, subject, "development", [
				{ ...item, id: item.id.toUpperCase(), sessionId: item.sessionId.toUpperCase() },
			]),
		).toEqual({ accepted: 1, duplicates: 0 });
		expect(await repo.ingest(owner.id, subject, "development", [item])).toEqual({
			accepted: 0,
			duplicates: 1,
		});
		await repo.ingest(owner.id, subject, "development", [
			{ ...event(), sessionId: item.sessionId.toUpperCase() },
		]);
		expect(
			new Set((await repo.history(owner.id, "development")).map((row) => row.sessionId)).size,
		).toBe(1);
	});
});

describe("optional shared-host storage cap", () => {
	it("validates capacity and counts only new unique events across all apps/environments", async () => {
		expect(() => new SQLiteRepository(db, { maxStoredEvents: 0 })).toThrow();
		expect(() => new SQLiteRepository(db, { maxStoredEvents: 1.5 })).toThrow();
		const capped = new SQLiteRepository(db, { maxStoredEvents: 2 });
		const first = event(),
			second = event();
		await capped.ingest(owner.id, subject, "development", [first]);
		await capped.ingest(owner.id, "other_subject", "production", [second]);
		expect(await capped.ingest(owner.id, subject, "development", [first])).toEqual({
			accepted: 0,
			duplicates: 1,
		});
		const other = await capped.createApp({ ...input, slug: "other" }, `${key}_other`);
		await expect(capped.ingest(other.id, subject, "development", [event()])).rejects.toThrow(
			"storage limit reached",
		);
		expect(await capped.history(other.id, "development")).toEqual([]);
		expect(await capped.deleteSubject(owner.id, subject)).toBe(1);
		expect(await capped.ingest(other.id, subject, "development", [event()])).toEqual({
			accepted: 1,
			duplicates: 0,
		});
	});
	it("rolls back the whole overflowing batch and reports a retryable HTTP capacity response", async () => {
		const capped = new SQLiteRepository(db, { maxStoredEvents: 2 });
		await capped.ingest(owner.id, subject, "development", [event()]);
		await expect(
			capped.ingest(owner.id, subject, "development", [event(), event()]),
		).rejects.toThrow("storage limit reached");
		expect(await capped.history(owner.id, "development")).toHaveLength(1);
		const api = createApi({
			repo: capped,
			tokenSecret: new Uint8Array(32).fill(5),
			now: () => now,
		});
		const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
		const response = await api.request("/v1/server/sessions", {
			method: "POST",
			headers,
			body: JSON.stringify({ subject, environment: "development" }),
		});
		const { token } = await response.json();
		const full = await api.request("/v1/events", {
			method: "POST",
			headers: { ...headers, Authorization: `Bearer ${token}` },
			body: JSON.stringify({ events: [event(), event()] }),
		});
		expect(full.status).toBe(503);
		expect(full.headers.get("Retry-After")).toBe("60");
		expect((await full.json()).error.code).toBe("storage_capacity");
		expect(await capped.history(owner.id, "development")).toHaveLength(1);
	});
});
