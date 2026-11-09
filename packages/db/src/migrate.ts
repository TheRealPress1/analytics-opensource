import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { connectDatabase } from "./index.js";
export async function migrate(pool: import("pg").Pool) {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SELECT pg_advisory_xact_lock(hashtext('subkit-migrations'))");
		await client.query(
			"CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
		);
		const directory = new URL("../migrations/", import.meta.url);
		for (const name of (await readdir(directory))
			.filter((name) => /^\d+_.+\.sql$/.test(name))
			.sort()) {
			const sql = await readFile(new URL(name, directory), "utf8");
			const checksum = createHash("sha256").update(sql).digest("hex");
			const existing = await client.query("SELECT checksum FROM schema_migrations WHERE name=$1", [
				name,
			]);
			if (existing.rowCount) {
				if (existing.rows[0].checksum !== checksum)
					throw new Error(`Applied migration changed: ${name}`);
				continue;
			}
			await client.query(sql);
			await client.query("INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)", [
				name,
				checksum,
			]);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const db = await connectDatabase();
	try {
		await migrate(db.pool);
		console.log("Usage schema ready");
	} finally {
		await db.close();
	}
}
