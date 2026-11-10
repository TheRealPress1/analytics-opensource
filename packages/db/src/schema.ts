import type { EventSpecs } from "@subkit/core";
import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

const stamps = {
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};
export const apps = pgTable("apps", {
	id: uuid("id").primaryKey(),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	secretKeyHash: text("secret_key_hash").notNull().unique(),
	eventSpecs: jsonb("event_specs").$type<EventSpecs>().notNull(),
	allowedOrigins: jsonb("allowed_origins").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
	...stamps,
});
export const events = pgTable(
	"events",
	{
		appId: uuid("app_id")
			.references(() => apps.id, { onDelete: "cascade" })
			.notNull(),
		environment: text("environment").notNull(),
		id: uuid("id").notNull(),
		subject: text("subject").notNull(),
		name: text("name").notNull(),
		sessionId: uuid("session_id").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
		properties: jsonb("properties").notNull(),
		payloadHash: text("payload_hash").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.appId, t.environment, t.id] }),
		check("events_environment_check", sql`${t.environment} IN ('production','development')`),
		index("events_app_time").on(t.appId, t.environment, t.occurredAt),
		index("events_subject_time").on(t.appId, t.environment, t.subject, t.occurredAt),
	],
);
export const rateLimits = pgTable("rate_limits", {
	key: text("key").primaryKey(),
	windowStart: bigint("window_start", { mode: "number" }).notNull(),
	count: integer("count").notNull(),
});
export const workerHeartbeats = pgTable("worker_heartbeats", {
	id: text("id").primaryKey(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
export const deletedSubjects = pgTable(
	"deleted_subjects",
	{
		appId: uuid("app_id")
			.references(() => apps.id, { onDelete: "cascade" })
			.notNull(),
		subject: text("subject").notNull(),
		deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.appId, t.subject] })],
);
