import { randomUUID } from "node:crypto";
import { hashKey, PostgresRepository } from "@subkit/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../packages/db/src/migrate.js";
import { createApi } from "./app.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Postgres HTTP boundary", () => {
	const pool = new pg.Pool({ connectionString: url });
	const repo = new PostgresRepository(pool);
	const now = new Date("2026-10-20T12:00:00Z");
	const secret = new Uint8Array(32).fill(7);
	const app = createApi({ repo, tokenSecret: secret, now: () => now });
	const appId = randomUUID(),
		otherId = randomUUID();
	const key = "sk_integration_fixture_a",
		otherKey = "sk_integration_fixture_b";
	const auth = (key: string) => ({
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
	});
	const event = {
		id: randomUUID(),
		name: "meal_logged",
		sessionId: randomUUID(),
		occurredAt: now.toISOString(),
		properties: {},
	};
	let token: string;
	beforeAll(async () => {
		await migrate(pool);
		await pool.query("DELETE FROM apps WHERE id IN ($1,$2) OR secret_key_hash IN ($3,$4)", [
			appId,
			otherId,
			hashKey(key),
			hashKey(otherKey),
		]);
		for (const [id, k] of [
			[appId, key],
			[otherId, otherKey],
		])
			await pool.query(
				"INSERT INTO apps(id,name,slug,secret_key_hash,event_specs) VALUES($1,$2,$3,$4,$5)",
				[
					id,
					"Synthetic",
					`fixture-${id}`,
					hashKey(k!),
					JSON.stringify({ meal_logged: {}, app_opened: {} }),
				],
			);
		const r = await app.request("/v1/server/sessions", {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({ subject: "fixture_user_1", environment: "development" }),
		});
		token = (await r.json()).token;
	});
	afterAll(async () => {
		await pool.query("DELETE FROM apps WHERE id IN ($1,$2)", [appId, otherId]);
		await pool.end();
	});
	it("health and schema readiness are honest", async () =>
		expect((await app.request("/readyz")).status).toBe(200));
	it("does not report ready when only the apps table exists", async () => {
		const schema = `readiness_${randomUUID().replaceAll("-", "")}`;
		await pool.query(`CREATE SCHEMA ${schema}`);
		const incompletePool = new pg.Pool({
			connectionString: url,
			options: `-c search_path=${schema}`,
		});
		try {
			await incompletePool.query("CREATE TABLE apps(id uuid)");
			const incomplete = createApi({
				repo: new PostgresRepository(incompletePool),
				tokenSecret: secret,
				now: () => now,
			});
			expect((await incomplete.request("/readyz")).status).toBe(503);
		} finally {
			await incompletePool.end();
			await pool.query(`DROP SCHEMA ${schema} CASCADE`);
		}
	});
	it("rejects unauthenticated reads and server-key event writes", async () => {
		expect((await app.request("/v1/server/analytics")).status).toBe(401);
		expect(
			(
				await app.request("/v1/events", {
					method: "POST",
					headers: auth(key),
					body: JSON.stringify({ events: [event] }),
				})
			).status,
		).toBe(401);
	});
	it("concurrent replay records exactly one event", async () => {
		const responses = await Promise.all(
			Array.from({ length: 8 }, () =>
				app.request("/v1/events", {
					method: "POST",
					headers: auth(token),
					body: JSON.stringify({ events: [event] }),
				}),
			),
		);
		const results = await Promise.all(responses.map((r) => r.json()));
		expect(results.reduce((sum, r) => sum + r.accepted, 0)).toBe(1);
		expect(results.reduce((sum, r) => sum + r.duplicates, 0)).toBe(7);
	});
	it("rejects changed content under the same id and rolls back the entire batch", async () => {
		const changed = { ...event, name: "app_opened" };
		const r = await app.request("/v1/events", {
			method: "POST",
			headers: auth(token),
			body: JSON.stringify({ events: [{ ...event, id: randomUUID() }, changed] }),
		});
		expect(r.status).toBe(409);
		expect(await repo.history(appId, "development")).toHaveLength(1);
	});
	it("isolates app keys and production from development", async () => {
		for (const [k, env] of [
			[otherKey, "development"],
			[key, "production"],
		]) {
			const r = await app.request(`/v1/server/analytics?environment=${env}`, { headers: auth(k!) });
			expect((await r.json()).totals.events).toBe(0);
		}
		const r = await app.request("/v1/server/analytics?environment=development", {
			headers: auth(key),
		});
		expect((await r.json()).totals.events).toBe(1);
	});
	it("rejects payload identity, health content, unregistered browser origin and oversized input", async () => {
		expect(
			(
				await app.request("/v1/events", {
					method: "POST",
					headers: auth(token),
					body: JSON.stringify({ events: [{ ...event, id: randomUUID(), subject: "other_user" }] }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/events", {
					method: "POST",
					headers: auth(token),
					body: JSON.stringify({
						events: [{ ...event, id: randomUUID(), properties: { lab: "private" } }],
					}),
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/events", {
					method: "POST",
					headers: { ...auth(token), Origin: "https://unregistered.invalid" },
					body: JSON.stringify({ events: [event] }),
				})
			).status,
		).toBe(403);
		expect(
			(
				await app.request("/v1/events", {
					method: "POST",
					headers: auth(token),
					body: "x".repeat(70000),
				})
			).status,
		).toBe(413);
	});
	it("makes auth and body-size failures visible only to registered browser origins", async () => {
		const origin = "https://analytics-app.example.test";
		await pool.query("UPDATE apps SET allowed_origins=$2 WHERE id=$1", [
			appId,
			JSON.stringify([origin]),
		]);
		const unauthorized = await app.request("/v1/events", {
			method: "POST",
			headers: { Origin: origin, ...auth("invalid") },
			body: JSON.stringify({ events: [event] }),
		});
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("Access-Control-Allow-Origin")).toBe(origin);
		const oversized = await app.request("/v1/events", {
			method: "POST",
			headers: { Origin: origin, ...auth(token) },
			body: "x".repeat(70000),
		});
		expect(oversized.status).toBe(413);
		expect(oversized.headers.get("Access-Control-Allow-Origin")).toBe(origin);
		const allowed = await app.request("/v1/events", {
			method: "OPTIONS",
			headers: { Origin: origin },
		});
		expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(origin);
		expect(allowed.headers.has("Access-Control-Allow-Credentials")).toBe(false);
		const unknown = await app.request("/v1/events", {
			method: "OPTIONS",
			headers: { Origin: "https://unknown.example.test" },
		});
		expect(unknown.headers.has("Access-Control-Allow-Origin")).toBe(false);
		const other = await app.request("/v1/server/sessions", {
			method: "POST",
			headers: auth(otherKey),
			body: JSON.stringify({ subject: "fixture_user_2", environment: "development" }),
		});
		const otherToken = (await other.json()).token;
		const crossApp = await app.request("/v1/events", {
			method: "POST",
			headers: { Origin: origin, ...auth(otherToken) },
			body: JSON.stringify({ events: [event] }),
		});
		expect(crossApp.status).toBe(403);
		expect(crossApp.headers.get("Access-Control-Allow-Origin")).toBe(origin);
	});
	it("rate limits across processes in the database", async () => {
		const key = randomUUID();
		expect(await repo.consumeRate(key, 1, now)).toBe(true);
		expect(await new PostgresRepository(pool).consumeRate(key, 1, now)).toBe(false);
	});
	it("deletes only the subject in this app and revokes outstanding collector sessions", async () => {
		const r = await app.request("/v1/server/subjects/fixture_user_1", {
			method: "DELETE",
			headers: auth(key),
		});
		expect((await r.json()).deleted).toBe(1);
		expect(
			(
				await app.request("/v1/events", {
					method: "POST",
					headers: auth(token),
					body: JSON.stringify({ events: [event] }),
				})
			).status,
		).toBe(410);
		expect(
			(
				await app.request("/v1/server/sessions", {
					method: "POST",
					headers: auth(key),
					body: JSON.stringify({ subject: "fixture_user_1", environment: "development" }),
				})
			).status,
		).toBe(410);
	});
});
