import { createHash, randomUUID } from "node:crypto";
import {
	type App,
	CapacityError,
	ConflictError,
	type Environment,
	type EventSpecs,
	eventSpecsSchema,
	type Repository,
	StorageCapacityError,
	type UsageEvent,
} from "@subkit/core";
import type Database from "better-sqlite3";

export { migrateSQLite } from "./migrate.js";

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const eventHash = (subject: string, event: UsageEvent) =>
	hashKey(
		JSON.stringify([
			subject,
			event.name,
			new Date(event.occurredAt).toISOString(),
			event.sessionId,
			Object.entries(event.properties).sort(([a], [b]) => a.localeCompare(b)),
		]),
	);
type Row = Record<string, unknown>;
const appRow = (row: Row): App => ({
	id: row.id as string,
	name: row.name as string,
	slug: row.slug as string,
	eventSpecs: JSON.parse(row.event_specs as string) as EventSpecs,
	allowedOrigins: JSON.parse(row.allowed_origins as string) as string[],
});

/** Borrows a host better-sqlite3 connection. Never opens/closes it or changes PRAGMAs. */
export class SQLiteRepository implements Repository {
	private readonly maxStoredEvents: number | undefined;
	constructor(
		readonly db: Database.Database,
		options: { maxStoredEvents?: number } = {},
	) {
		const limit = options.maxStoredEvents;
		if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
			throw new RangeError("maxStoredEvents must be a positive safe integer");
		this.maxStoredEvents = limit;
	}
	async health() {
		this.db
			.prepare(
				"SELECT 1 FROM subkit_analytics_apps,subkit_analytics_events,subkit_analytics_rate_limits,subkit_analytics_deleted_subjects LIMIT 0",
			)
			.all();
	}
	async appByKey(key: string) {
		const row = this.db
			.prepare("SELECT * FROM subkit_analytics_apps WHERE secret_key_hash=?")
			.get(hashKey(key)) as Row | undefined;
		return row ? appRow(row) : null;
	}
	async appById(id: string) {
		const row = this.db
			.prepare("SELECT * FROM subkit_analytics_apps WHERE id=?")
			.get(id.toLowerCase()) as Row | undefined;
		return row ? appRow(row) : null;
	}
	async appBySlug(slug: string) {
		const row = this.db.prepare("SELECT * FROM subkit_analytics_apps WHERE slug=?").get(slug) as
			| Row
			| undefined;
		return row ? appRow(row) : null;
	}
	async listApps(): Promise<App[]> {
		return (
			this.db.prepare("SELECT * FROM subkit_analytics_apps ORDER BY name,id").all() as Row[]
		).map(appRow);
	}
	async allowedOrigin(origin: string) {
		return !!this.db
			.prepare(
				"SELECT 1 FROM subkit_analytics_apps,json_each(subkit_analytics_apps.allowed_origins) AS origin WHERE origin.value=? LIMIT 1",
			)
			.get(origin);
	}
	async consumeRate(key: string, limit: number, now: Date) {
		const row = this.db
			.prepare(`INSERT INTO subkit_analytics_rate_limits(key,window_start,count) VALUES(?,?,1)
   ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,
   count=CASE WHEN subkit_analytics_rate_limits.window_start=excluded.window_start THEN subkit_analytics_rate_limits.count+1 ELSE 1 END RETURNING count`)
			.get(hashKey(key), Math.floor(now.getTime() / 60_000)) as { count: number };
		return row.count <= limit;
	}
	async ingest(appId: string, subject: string, environment: Environment, batch: UsageEvent[]) {
		appId = appId.toLowerCase();
		return this.db
			.transaction(() => {
				if (!this.db.prepare("SELECT 1 FROM subkit_analytics_apps WHERE id=?").get(appId))
					throw new ConflictError("Unknown app");
				if (
					this.db
						.prepare("SELECT 1 FROM subkit_analytics_deleted_subjects WHERE app_id=? AND subject=?")
						.get(appId, subject)
				)
					throw new ConflictError("Subject has been deleted");
				const insert = this.db.prepare(
					"INSERT INTO subkit_analytics_events(app_id,environment,id,subject,name,session_id,occurred_at,received_at,properties,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(app_id,environment,id) DO NOTHING",
				);
				const previous = this.db.prepare(
					"SELECT payload_hash FROM subkit_analytics_events WHERE app_id=? AND environment=? AND id=?",
				);
				const stored =
					this.maxStoredEvents === undefined
						? 0
						: (
								this.db.prepare("SELECT count(*) AS count FROM subkit_analytics_events").get() as {
									count: number;
								}
							).count;
				let accepted = 0,
					duplicates = 0;
				for (const raw of batch) {
					const event = {
						...raw,
						id: raw.id.toLowerCase(),
						sessionId: raw.sessionId.toLowerCase(),
					};
					const hash = eventHash(subject, event);
					const result = insert.run(
						appId,
						environment,
						event.id,
						subject,
						event.name,
						event.sessionId,
						new Date(event.occurredAt).toISOString(),
						new Date().toISOString(),
						JSON.stringify(event.properties),
						hash,
					);
					if (result.changes) {
						if (this.maxStoredEvents !== undefined && stored + accepted >= this.maxStoredEvents)
							throw new StorageCapacityError(
								"Analytics storage limit reached; collection is paused until capacity is available",
							);
						accepted++;
						continue;
					}
					const old = previous.get(appId, environment, event.id) as
						| { payload_hash: string }
						| undefined;
					if (old?.payload_hash !== hash)
						throw new ConflictError("Event ID belongs to different content");
					duplicates++;
				}
				return { accepted, duplicates };
			})
			.immediate();
	}
	async history(appId: string, environment: Environment) {
		appId = appId.toLowerCase();
		const rows = this.db
			.prepare(
				"SELECT subject,name,session_id,occurred_at FROM subkit_analytics_events WHERE app_id=? AND environment=? ORDER BY occurred_at,id LIMIT 100001",
			)
			.all(appId, environment) as Row[];
		if (rows.length > 100000)
			throw new CapacityError(
				"Interactive history exceeds 100000 events; use a warehouse rollup before scaling this preview",
			);
		return rows.map((row) => ({
			subject: row.subject as string,
			name: row.name as string,
			sessionId: row.session_id as string,
			occurredAt: row.occurred_at as string,
		}));
	}
	async latest(appId: string, environment: Environment, limit: number) {
		appId = appId.toLowerCase();
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new RangeError("Event limit must be between 1 and 100");
		const rows = this.db
			.prepare(
				"SELECT * FROM subkit_analytics_events WHERE app_id=? AND environment=? ORDER BY occurred_at DESC,id LIMIT ?",
			)
			.all(appId, environment, limit) as Row[];
		return rows.map((row) => ({
			id: row.id as string,
			subject: row.subject as string,
			name: row.name as string,
			sessionId: row.session_id as string,
			occurredAt: row.occurred_at as string,
			receivedAt: row.received_at as string,
			properties: JSON.parse(row.properties as string) as UsageEvent["properties"],
		}));
	}
	async isSubjectDeleted(appId: string, subject: string) {
		appId = appId.toLowerCase();
		return !!this.db
			.prepare("SELECT 1 FROM subkit_analytics_deleted_subjects WHERE app_id=? AND subject=?")
			.get(appId, subject);
	}
	async deleteSubject(appId: string, subject: string) {
		appId = appId.toLowerCase();
		return this.db
			.transaction(() => {
				if (!this.db.prepare("SELECT 1 FROM subkit_analytics_apps WHERE id=?").get(appId))
					throw new ConflictError("Unknown app");
				this.db
					.prepare(
						"INSERT INTO subkit_analytics_deleted_subjects(app_id,subject,deleted_at) VALUES(?,?,?) ON CONFLICT(app_id,subject) DO NOTHING",
					)
					.run(appId, subject, new Date().toISOString());
				return this.db
					.prepare("DELETE FROM subkit_analytics_events WHERE app_id=? AND subject=?")
					.run(appId, subject).changes;
			})
			.immediate();
	}
	async createApp(
		input: { name: string; slug: string; eventSpecs: EventSpecs; allowedOrigins: string[] },
		secretKey: string,
	): Promise<App> {
		if (
			!input.name.trim() ||
			input.name.length > 100 ||
			!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug) ||
			!/^sk_[A-Za-z0-9_-]{24,}$/.test(secretKey)
		)
			throw new TypeError("Invalid analytics app configuration");
		const eventSpecs = eventSpecsSchema.parse(input.eventSpecs);
		if (
			input.allowedOrigins.length > 100 ||
			input.allowedOrigins.some((origin) => {
				try {
					const url = new URL(origin);
					return url.origin !== origin || !["https:", "http:"].includes(url.protocol);
				} catch {
					return true;
				}
			})
		)
			throw new TypeError("Invalid allowed origin");
		const app = { ...input, eventSpecs, id: randomUUID() };
		const now = new Date().toISOString();
		this.db
			.prepare(
				"INSERT INTO subkit_analytics_apps(id,name,slug,secret_key_hash,event_specs,allowed_origins,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
			)
			.run(
				app.id,
				app.name,
				app.slug,
				hashKey(secretKey),
				JSON.stringify(eventSpecs),
				JSON.stringify(app.allowedOrigins),
				now,
				now,
			);
		return app;
	}
	/** Deletes only old analytics rate-limit rows, never event history or host data. */
	async cleanupRateLimits({ before, limit = 1000 }: { before: Date; limit?: number }) {
		if (
			!Number.isFinite(before.getTime()) ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 10000
		)
			throw new RangeError("Invalid cleanup boundary or limit");
		const window = Math.floor(before.getTime() / 60_000);
		return this.db
			.prepare(
				"DELETE FROM subkit_analytics_rate_limits WHERE key IN (SELECT key FROM subkit_analytics_rate_limits WHERE window_start < ? ORDER BY window_start,key LIMIT ?)",
			)
			.run(window, limit).changes;
	}
}
