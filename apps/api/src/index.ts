import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { connectDatabase, PostgresRepository } from "@subkit/db";
import pino from "pino";
import { createApi } from "./app.js";

const logger = pino({
	redact: ["req.headers.authorization", "token", "secret", "properties", "subject"],
});
const file = process.env.SUBKIT_TOKEN_SECRET_FILE;
if (!file) throw new Error("SUBKIT_TOKEN_SECRET_FILE must point to a mounted signing key");
const tokenSecret = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
const db = await connectDatabase();
const app = createApi({ repo: new PostgresRepository(db.pool), tokenSecret });
const server = serve({
	fetch: app.fetch,
	port: Number(process.env.PORT ?? 8080),
	hostname: "0.0.0.0",
});
logger.info({ port: Number(process.env.PORT ?? 8080) }, "Analytics API started");
const shutdown = () => {
	const timer = setTimeout(() => process.exit(1), 9000);
	timer.unref();
	server.close(() => {
		void db.close().then(() => process.exit(0));
	});
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
