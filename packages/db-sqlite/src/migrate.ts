import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

// Keep applied SQL immutable; future changes belong in a new numbered migration.
const migrations = [
	{
		name: "0001_usage",
		sql: `CREATE TABLE subkit_analytics_apps (
 id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
 secret_key_hash TEXT NOT NULL UNIQUE, event_specs TEXT NOT NULL CHECK(json_valid(event_specs)),
 allowed_origins TEXT NOT NULL CHECK(json_valid(allowed_origins)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE subkit_analytics_events (
 app_id TEXT NOT NULL REFERENCES subkit_analytics_apps(id),
 environment TEXT NOT NULL CHECK(environment IN ('production','development')),
 id TEXT NOT NULL, subject TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
 properties TEXT NOT NULL CHECK(json_valid(properties)), payload_hash TEXT NOT NULL,
 PRIMARY KEY(app_id,environment,id)
);
CREATE INDEX subkit_analytics_events_app_time ON subkit_analytics_events(app_id,environment,occurred_at);
CREATE INDEX subkit_analytics_events_subject_time ON subkit_analytics_events(app_id,environment,subject,occurred_at);
CREATE TABLE subkit_analytics_rate_limits (key TEXT PRIMARY KEY NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX subkit_analytics_rate_limits_window ON subkit_analytics_rate_limits(window_start);
CREATE TABLE subkit_analytics_deleted_subjects (
 app_id TEXT NOT NULL REFERENCES subkit_analytics_apps(id), subject TEXT NOT NULL,
 deleted_at TEXT NOT NULL, PRIMARY KEY(app_id,subject)
);`,
	},
];

/** Explicit additive migration. The host owns the connection and all PRAGMAs. */
export function migrateSQLite(db: Database.Database): void {
	db.transaction(() => {
		db.exec(
			"CREATE TABLE IF NOT EXISTS subkit_analytics_migrations (name TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
		);
		for (const migration of migrations) {
			const checksum = createHash("sha256").update(migration.sql).digest("hex");
			const existing = db
				.prepare("SELECT checksum FROM subkit_analytics_migrations WHERE name=?")
				.get(migration.name) as { checksum: string } | undefined;
			if (existing) {
				if (existing.checksum !== checksum)
					throw new Error(`Applied analytics migration changed: ${migration.name}`);
				continue;
			}
			db.exec(migration.sql);
			db.prepare(
				"INSERT INTO subkit_analytics_migrations(name,checksum,applied_at) VALUES(?,?,?)",
			).run(migration.name, checksum, new Date().toISOString());
		}
	}).immediate();
}
