import { z } from "zod";

export const environmentSchema = z.enum(["production", "development"]);
export type Environment = z.infer<typeof environmentSchema>;
export const propertyRuleSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("boolean") }).strict(),
	z
		.object({ type: z.literal("number"), min: z.number().finite(), max: z.number().finite() })
		.strict(),
	z
		.object({ type: z.literal("enum"), values: z.array(z.string().min(1).max(40)).min(1).max(30) })
		.strict(),
]);
export const eventSpecsSchema = z.record(
	z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
	z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), propertyRuleSchema),
);
export type EventSpecs = z.infer<typeof eventSpecsSchema>;
export const eventSchema = z
	.object({
		id: z.uuid(),
		name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
		occurredAt: z.iso.datetime({ offset: true }),
		sessionId: z.uuid(),
		properties: z
			.record(z.string(), z.union([z.boolean(), z.number().finite(), z.string().max(40)]))
			.default({}),
	})
	.strict();
export type UsageEvent = z.infer<typeof eventSchema>;
export class ValidationError extends Error {}
export function validateBatch(body: unknown, specs: EventSpecs, now = new Date()): UsageEvent[] {
	const { events } = z
		.object({ events: z.array(eventSchema).min(1).max(50) })
		.strict()
		.parse(body);
	const ids = new Set<string>();
	for (const event of events) {
		if (ids.has(event.id)) throw new ValidationError("Duplicate event ID in batch");
		ids.add(event.id);
		const spec = Object.hasOwn(specs, event.name) ? specs[event.name] : undefined;
		if (!spec) throw new ValidationError("Event is not approved for this app");
		const time = Date.parse(event.occurredAt);
		if (time > now.getTime() + 300_000 || time < now.getTime() - 30 * 86_400_000)
			throw new ValidationError("Event time outside allowed window");
		if (Object.keys(event.properties).length > 10) throw new ValidationError("Too many properties");
		for (const [key, value] of Object.entries(event.properties)) {
			const rule = Object.hasOwn(spec, key) ? spec[key] : undefined;
			if (!rule) throw new ValidationError("Property is not approved for this event");
			if (rule.type === "boolean" && typeof value === "boolean") continue;
			if (
				rule.type === "number" &&
				typeof value === "number" &&
				value >= rule.min &&
				value <= rule.max
			)
				continue;
			if (rule.type === "enum" && typeof value === "string" && rule.values.includes(value))
				continue;
			throw new ValidationError("Property value outside approved schema");
		}
	}
	return events;
}

export interface AnalyticsEvent {
	subject: string;
	occurredAt: string;
	name: string;
	sessionId: string;
}
const DAY = 86_400_000;
export const dateKey = (date: Date) => date.toISOString().slice(0, 10);
export function parseDay(value: string): number {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError("Dates must use YYYY-MM-DD");
	const time = Date.parse(`${value}T00:00:00Z`);
	if (!Number.isFinite(time) || dateKey(new Date(time)) !== value)
		throw new ValidationError("Invalid calendar date");
	return time;
}
export function analyze(
	input: AnalyticsEvent[],
	from: string,
	to: string,
	now = new Date(),
	funnel: string[] = [],
	eventName?: string,
) {
	const start = parseDay(from),
		end = parseDay(to),
		today = parseDay(dateKey(now));
	if (start > end || end > today || end - start > 3660 * DAY)
		throw new ValidationError("Invalid date range (maximum ten years)");
	if (funnel.length > 8) throw new ValidationError("Maximum eight funnel steps");
	const history = input
		.filter(
			(e) => (!eventName || e.name === eventName) && Date.parse(e.occurredAt) <= now.getTime(),
		)
		.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
	const selected = history.filter(
		(e) => Date.parse(e.occurredAt) >= start && Date.parse(e.occurredAt) < end + DAY,
	);
	const users = (events: AnalyticsEvent[]) => new Set(events.map((e) => e.subject)).size;
	const sessions = (events: AnalyticsEvent[]) =>
		new Set(events.map((e) => JSON.stringify([e.subject, e.sessionId]))).size;
	const groups = new Map<string, AnalyticsEvent[]>();
	const cohorts = new Map<string, Set<string>>();
	const first = new Set<string>();
	const active = new Map<string, Set<string>>();
	for (const e of history) {
		const day = dateKey(new Date(e.occurredAt));
		const set = active.get(day) ?? new Set<string>();
		set.add(e.subject);
		active.set(day, set);
		if (!first.has(e.subject)) {
			first.add(e.subject);
			const cohort = cohorts.get(day) ?? new Set<string>();
			cohort.add(e.subject);
			cohorts.set(day, cohort);
		}
	}
	for (const e of selected) {
		const day = dateKey(new Date(e.occurredAt));
		const group = groups.get(day) ?? [];
		group.push(e);
		groups.set(day, group);
	}
	const daily = [];
	for (let t = start; t <= end; t += DAY) {
		const date = dateKey(new Date(t));
		const events = groups.get(date) ?? [];
		daily.push({
			date,
			events: events.length,
			activeUsers: users(events),
			sessions: sessions(events),
		});
	}
	const names = [...new Set(selected.map((e) => e.name))];
	const topEvents = names
		.map((name) => {
			const events = selected.filter((e) => e.name === name);
			return { name, count: events.length, users: users(events) };
		})
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	const retention = [...cohorts.entries()]
		.filter(([day]) => day >= from && day <= to)
		.map(([cohortDate, members]) => {
			const retained = (offset: number) => {
				const time = parseDay(cohortDate) + offset * DAY;
				if (time >= today) return null;
				const onDay = active.get(dateKey(new Date(time)));
				return [...members].filter((id) => onDay?.has(id)).length / members.size;
			};
			return {
				cohortDate,
				users: members.size,
				day1: retained(1),
				day7: retained(7),
				day30: retained(30),
			};
		});
	let previous = new Map<string, number>();
	const steps = funnel.map((name, index) => {
		const next = new Map<string, number>();
		for (const e of selected) {
			const time = Date.parse(e.occurredAt);
			if (
				e.name === name &&
				!next.has(e.subject) &&
				(index === 0 || (previous.has(e.subject) && time > previous.get(e.subject)!))
			)
				next.set(e.subject, time);
		}
		const denominator = index === 0 ? next.size : previous.size;
		previous = next;
		return { name, users: next.size, conversionRate: denominator ? next.size / denominator : null };
	});
	const recent = (days: number) =>
		history.filter((e) => Date.parse(e.occurredAt) >= today - (days - 1) * DAY);
	return {
		from,
		to,
		generatedAt: now.toISOString(),
		totals: {
			events: selected.length,
			activeUsers: users(selected),
			sessions: sessions(selected),
			eventsToday: recent(1).length,
			activeToday: users(recent(1)),
			active7Days: users(recent(7)),
			active30Days: users(recent(30)),
		},
		daily,
		topEvents,
		retention,
		funnel: steps,
		coverage: {
			firstEventAt: history[0]?.occurredAt ?? null,
			lastEventAt: history.at(-1)?.occurredAt ?? null,
		},
	};
}

export {
	type App,
	CapacityError,
	ConflictError,
	type Repository,
	StorageCapacityError,
	type StoredEvent,
} from "./repository.js";
