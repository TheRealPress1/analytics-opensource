import { createHash, randomUUID } from "node:crypto";
import { AuthTypes, Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import type { AnalyticsEvent, Environment, EventSpecs, UsageEvent } from "@subkit/core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { apps } from "./schema.js";

export { apps, deletedSubjects, events } from "./schema.js";
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
export async function executeQueueSql(pool: pg.Pool, text: string, values?: unknown[]) {
	const result = await pool.query(text, values);
	// pg-boss uses multi-statement transactions; preserve rows from every statement.
	return { rows: Array.isArray(result) ? result.flatMap((part) => part.rows) : result.rows };
}
export interface App {
	id: string;
	name: string;
	slug: string;
	eventSpecs: EventSpecs;
	allowedOrigins: string[];
}
export interface StoredEvent extends AnalyticsEvent {
	id: string;
	properties: UsageEvent["properties"];
	receivedAt: string;
}
export class ConflictError extends Error {}
export class CapacityError extends Error {}
export interface Repository {
	health(): Promise<void>;
	appByKey(key: string): Promise<App | null>;
	appById(id: string): Promise<App | null>;
	allowedOrigin(origin: string): Promise<boolean>;
	consumeRate(key: string, limit: number, now: Date): Promise<boolean>;
	ingest(
		appId: string,
		subject: string,
		environment: Environment,
		events: UsageEvent[],
	): Promise<{ accepted: number; duplicates: number }>;
	history(appId: string, environment: Environment): Promise<AnalyticsEvent[]>;
	latest(appId: string, environment: Environment, limit: number): Promise<StoredEvent[]>;
	deleteSubject(appId: string, subject: string): Promise<number>;
	isSubjectDeleted(appId: string, subject: string): Promise<boolean>;
}
export async function connectDatabase() {
	let connector: Connector | undefined;
	let options: pg.PoolConfig;
	if (process.env.DATABASE_URL) {
		if (process.env.NODE_ENV === "production")
			throw new Error("Production requires private Cloud SQL connector IAM authentication");
		options = { connectionString: process.env.DATABASE_URL };
	} else {
		const instanceConnectionName = process.env.INSTANCE_CONNECTION_NAME,
			user = process.env.DB_USER,
			database = process.env.DB_NAME;
		if (!instanceConnectionName || !user || !database)
			throw new Error("Database configuration missing");
		connector = new Connector();
		options = {
			...(await connector.getOptions({
				instanceConnectionName,
				ipType: IpAddressTypes.PRIVATE,
				authType: AuthTypes.IAM,
			})),
			user,
			database,
		};
	}
	const pool = new pg.Pool({
		...options,
		max: 10,
		connectionTimeoutMillis: 10_000,
		statement_timeout: 15_000,
	});
	pool.on("error", () => {
		/* operations report sanitized failures; never print credentials */
	});
	return {
		pool,
		close: async () => {
			await pool.end();
			connector?.close();
		},
	};
}
const appRow = (r: Record<string, unknown>): App => ({
	id: r.id as string,
	name: r.name as string,
	slug: r.slug as string,
	eventSpecs: r.event_specs as EventSpecs,
	allowedOrigins: r.allowed_origins as string[],
});
const eventHash = (subject: string, e: UsageEvent) =>
	hashKey(
		JSON.stringify([
			subject,
			e.name,
			new Date(e.occurredAt).toISOString(),
			e.sessionId,
			Object.entries(e.properties).sort(([a], [b]) => a.localeCompare(b)),
		]),
	);
export class PostgresRepository implements Repository {
	constructor(readonly pool: pg.Pool) {}
	async health() {
		await this.pool.query("SELECT 1 FROM apps, events, rate_limits, deleted_subjects LIMIT 0");
	}
	async allowedOrigin(origin: string) {
		const result = await this.pool.query(
			"SELECT 1 FROM apps WHERE allowed_origins @> $1::jsonb LIMIT 1",
			[JSON.stringify([origin])],
		);
		return !!result.rowCount;
	}
	async appByKey(key: string) {
		const r = await this.pool.query("SELECT * FROM apps WHERE secret_key_hash=$1", [hashKey(key)]);
		return r.rows[0] ? appRow(r.rows[0]) : null;
	}
	async appById(id: string) {
		const r = await this.pool.query("SELECT * FROM apps WHERE id=$1", [id]);
		return r.rows[0] ? appRow(r.rows[0]) : null;
	}
	async consumeRate(key: string, limit: number, now: Date) {
		const window = Math.floor(now.getTime() / 60_000);
		const r = await this.pool.query(
			`INSERT INTO rate_limits(key,window_start,count) VALUES($1,$2,1) ON CONFLICT(key) DO UPDATE SET window_start=EXCLUDED.window_start,count=CASE WHEN rate_limits.window_start=EXCLUDED.window_start THEN rate_limits.count+1 ELSE 1 END RETURNING count`,
			[hashKey(key), window],
		);
		return Number(r.rows[0].count) <= limit;
	}
	async ingest(appId: string, subject: string, environment: Environment, batch: UsageEvent[]) {
		const client = await this.pool.connect();
		let accepted = 0,
			duplicates = 0;
		try {
			await client.query("BEGIN");
			await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				`${appId}:${subject}`,
			]);
			if (
				(
					await client.query("SELECT 1 FROM deleted_subjects WHERE app_id=$1 AND subject=$2", [
						appId,
						subject,
					])
				).rowCount
			)
				throw new ConflictError("Subject has been deleted");
			// Stable lock order avoids deadlocks when two SDK batches overlap.
			for (const e of [...batch].sort((a, b) => a.id.localeCompare(b.id))) {
				const hash = eventHash(subject, e);
				const r = await client.query(
					"INSERT INTO events(app_id,environment,id,subject,name,session_id,occurred_at,properties,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id",
					[
						appId,
						environment,
						e.id,
						subject,
						e.name,
						e.sessionId,
						e.occurredAt,
						JSON.stringify(e.properties),
						hash,
					],
				);
				if (r.rowCount) {
					accepted++;
					continue;
				}
				const old = await client.query(
					"SELECT payload_hash FROM events WHERE app_id=$1 AND environment=$2 AND id=$3",
					[appId, environment, e.id],
				);
				if (old.rows[0]?.payload_hash !== hash)
					throw new ConflictError("Event ID belongs to different content");
				duplicates++;
			}
			await client.query("COMMIT");
			return { accepted, duplicates };
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	async history(appId: string, environment: Environment) {
		const r = await this.pool.query(
			"SELECT subject,name,session_id,occurred_at FROM events WHERE app_id=$1 AND environment=$2 ORDER BY occurred_at LIMIT 100001",
			[appId, environment],
		);
		if (r.rows.length > 100000)
			throw new CapacityError(
				"Interactive history exceeds 100000 events; use a warehouse rollup before scaling this preview",
			);
		return r.rows.map((row) => ({
			subject: row.subject,
			name: row.name,
			sessionId: row.session_id,
			occurredAt: row.occurred_at.toISOString(),
		}));
	}
	async latest(appId: string, environment: Environment, limit: number) {
		const r = await this.pool.query(
			"SELECT * FROM events WHERE app_id=$1 AND environment=$2 ORDER BY occurred_at DESC,id LIMIT $3",
			[appId, environment, limit],
		);
		return r.rows.map((row) => ({
			id: row.id,
			subject: row.subject,
			name: row.name,
			sessionId: row.session_id,
			occurredAt: row.occurred_at.toISOString(),
			receivedAt: row.received_at.toISOString(),
			properties: row.properties,
		}));
	}
	async isSubjectDeleted(appId: string, subject: string) {
		const r = await this.pool.query(
			"SELECT 1 FROM deleted_subjects WHERE app_id=$1 AND subject=$2",
			[appId, subject],
		);
		return !!r.rowCount;
	}
	async deleteSubject(appId: string, subject: string) {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				`${appId}:${subject}`,
			]);
			await client.query(
				"INSERT INTO deleted_subjects(app_id,subject) VALUES($1,$2) ON CONFLICT DO NOTHING",
				[appId, subject],
			);
			const r = await client.query("DELETE FROM events WHERE app_id=$1 AND subject=$2", [
				appId,
				subject,
			]);
			await client.query("COMMIT");
			return r.rowCount ?? 0;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	async createApp(
		input: { name: string; slug: string; eventSpecs: EventSpecs; allowedOrigins: string[] },
		secretKey: string,
	) {
		const db = drizzle(this.pool);
		const [row] = await db
			.insert(apps)
			.values({ ...input, id: randomUUID(), secretKeyHash: hashKey(secretKey) })
			.returning();
		return row;
	}
}
