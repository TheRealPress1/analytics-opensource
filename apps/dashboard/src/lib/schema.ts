import { z } from "zod";

const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(1).nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const appSchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
});
export const analyticsSchema = z.object({
	app: appSchema,
	environment: z.enum(["production", "development"]),
	from: date,
	to: date,
	generatedAt: z.string(),
	totals: z.object({
		events: count,
		activeUsers: count,
		sessions: count,
		eventsToday: count,
		activeToday: count,
		active7Days: count,
		active30Days: count,
	}),
	daily: z.array(z.object({ date, events: count, activeUsers: count, sessions: count })),
	topEvents: z.array(z.object({ name: z.string(), count, users: count })),
	retention: z.array(
		z.object({
			cohortDate: date,
			users: count,
			day1: rate,
			day7: rate,
			day30: rate,
		}),
	),
	funnel: z.array(z.object({ name: z.string(), users: count, conversionRate: rate })),
	coverage: z.object({
		firstEventAt: z.string().nullable(),
		lastEventAt: z.string().nullable(),
	}),
});
export type Analytics = z.infer<typeof analyticsSchema>;
export const appInfoSchema = appSchema.extend({
	eventNames: z.array(z.string()),
});
export type AppChoice = { name: string; slug: string };
