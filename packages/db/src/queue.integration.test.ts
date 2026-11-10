import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { executeQueueSql } from "./index.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Postgres queue adapter", () => {
	const pool = new pg.Pool({ connectionString: url, max: 1 });
	afterAll(async () => {
		await pool.end();
	});
	it("preserves a parameterized statement's rows", async () => {
		await expect(
			executeQueueSql(pool, "SELECT $1::text AS marker", ["queue-payload"]),
		).resolves.toEqual({
			rows: [{ marker: "queue-payload" }],
		});
	});

	it("preserves the advisory-lock and payload rows inside a multi-statement queue transaction", async () => {
		const result = await executeQueueSql(
			pool,
			`BEGIN;
			 SELECT pg_advisory_xact_lock(hashtext('subkit-queue-adapter-test'));
			 SELECT 'queue-payload'::text AS marker;
			 COMMIT;`,
		);
		// pg-boss BAM checks the lock row before processing command rows. COMMIT has no rows.
		expect(result.rows).toHaveLength(2);
		expect(result.rows[0]).toHaveProperty("pg_advisory_xact_lock");
		expect(result.rows[1]).toEqual({ marker: "queue-payload" });
	});
});
