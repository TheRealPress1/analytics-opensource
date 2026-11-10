import type { AnalyticsEvent, Environment, EventSpecs, UsageEvent } from "./index.js";

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
export class StorageCapacityError extends Error {}
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
