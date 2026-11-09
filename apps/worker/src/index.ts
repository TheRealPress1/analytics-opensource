import { serve } from "@hono/node-server";
import { connectDatabase } from "@subkit/db";
import { Hono } from "hono";
import { PgBoss } from "pg-boss";
import pino from "pino";

const logger = pino();
const db = await connectDatabase();
const boss = new PgBoss({
	// The production queue schema is owned by this identity but created by bootstrap.
	createSchema: process.env.NODE_ENV !== "production",
	db: {
		executeSql: async (text, values) => {
			const result = await db.pool.query(text, values);
			return { rows: result.rows };
		},
	},
});
boss.on("error", () => logger.error("Worker queue error"));
await boss.start();
await boss.createQueue("usage-housekeeping");
await boss.work("usage-housekeeping", async () => {
	await db.pool.query("DELETE FROM rate_limits WHERE window_start < $1", [
		Math.floor(Date.now() / 60_000) - 60,
	]);
});
await boss.schedule("usage-housekeeping", "*/15 * * * *", {});
// Durable event writes are synchronous. No worker queue can lose accepted client events.
const heartbeat = async () => {
	await db.pool.query(
		"INSERT INTO worker_heartbeats(id,updated_at) VALUES('usage',now()) ON CONFLICT(id) DO UPDATE SET updated_at=now()",
	);
};
await heartbeat();
let heartbeatHealthy = true;
const timer = setInterval(() => {
	void heartbeat()
		.then(() => {
			heartbeatHealthy = true;
		})
		.catch(() => {
			heartbeatHealthy = false;
			logger.error("Worker heartbeat unavailable");
		});
}, 30_000);
const app = new Hono();
app.get("/healthz", (c) => c.json({ status: "ok" }));
app.get("/readyz", async (c) => {
	try {
		if (!heartbeatHealthy) throw new Error();
		await db.pool.query("SELECT 1 FROM pgboss.job LIMIT 1");
		return c.json({ status: "ready" });
	} catch {
		return c.json({ status: "not_ready" }, 503);
	}
});
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
logger.info("Usage worker ready");
let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	clearInterval(timer);
	const deadline = setTimeout(() => process.exit(1), 9000);
	deadline.unref();
	server.close();
	await boss.stop({ timeout: 5000 });
	await db.close();
	process.exit(0);
};
process.on("SIGTERM", () => {
	void shutdown();
});
process.on("SIGINT", () => {
	void shutdown();
});
