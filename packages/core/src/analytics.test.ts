import { describe, expect, it } from "vitest";
import { type AnalyticsEvent, analyze, validateBatch } from "./index.js";

const now = new Date("2026-10-20T12:00:00Z");
const e = (
	subject: string,
	day: string,
	name = "app_opened",
	sessionId = "session1",
): AnalyticsEvent => ({ subject, occurredAt: `2026-10-${day}T10:00:00Z`, name, sessionId });
describe("usage metrics from actual events", () => {
	it("zero-fills days, counts users once and scopes session IDs by user", () => {
		const result = analyze(
			[e("a", "18"), e("a", "18"), e("b", "18"), e("a", "20")],
			"2026-10-18",
			"2026-10-20",
			now,
		);
		expect(result.daily).toEqual([
			{ date: "2026-10-18", events: 3, activeUsers: 2, sessions: 2 },
			{ date: "2026-10-19", events: 0, activeUsers: 0, sessions: 0 },
			{ date: "2026-10-20", events: 1, activeUsers: 1, sessions: 1 },
		]);
		expect(result.totals).toMatchObject({
			events: 4,
			activeUsers: 2,
			sessions: 2,
			eventsToday: 1,
			activeToday: 1,
			active7Days: 2,
			active30Days: 2,
		});
	});
	it("does not report immature cohorts as zero retention", () => {
		const result = analyze(
			[e("a", "18"), e("b", "18"), e("a", "19"), e("c", "20")],
			"2026-10-18",
			"2026-10-20",
			now,
		);
		expect(result.retention).toEqual([
			{ cohortDate: "2026-10-18", users: 2, day1: 0.5, day7: null, day30: null },
			{ cohortDate: "2026-10-20", users: 1, day1: null, day7: null, day30: null },
		]);
	});
	it("requires strictly ordered funnel steps and counts a subject once", () => {
		const events = [
			e("a", "18", "opened"),
			e("a", "19", "logged"),
			e("b", "18", "logged"),
			e("b", "19", "opened"),
			e("c", "18", "opened"),
			e("c", "18", "logged"),
		];
		expect(analyze(events, "2026-10-18", "2026-10-20", now, ["opened", "logged"]).funnel).toEqual([
			{ name: "opened", users: 3, conversionRate: 1 },
			{ name: "logged", users: 1, conversionRate: 1 / 3 },
		]);
	});
	it("keeps original cohort dates when selected range starts later", () => {
		expect(
			analyze([e("a", "01"), e("a", "18")], "2026-10-18", "2026-10-20", now).retention,
		).toEqual([]);
	});
	it("counts only complete return days and handles empty input", () => {
		expect(analyze([], "2026-10-20", "2026-10-20", now).totals.events).toBe(0);
		expect(
			analyze([e("a", "19"), e("a", "20")], "2026-10-19", "2026-10-20", now).retention[0]?.day1,
		).toBeNull();
	});
	it("rejects impossible, reversed and future date ranges", () => {
		for (const [from, to] of [
			["2026-02-30", "2026-03-02"],
			["2026-10-21", "2026-10-20"],
			["2026-10-20", "2026-10-21"],
		])
			expect(() => analyze([], from!, to!, now)).toThrow();
	});
});
describe("strict event intake", () => {
	const event = {
		id: "00000000-0000-4000-8000-000000000001",
		name: "meal_logged",
		occurredAt: now.toISOString(),
		sessionId: "00000000-0000-4000-8000-000000000002",
		properties: {},
	};
	const spec = { meal_logged: { method: { type: "enum" as const, values: ["manual", "camera"] } } };
	it("accepts only named events with approved bounded properties", () =>
		expect(
			validateBatch({ events: [{ ...event, properties: { method: "camera" } }] }, spec, now),
		).toHaveLength(1));
	it("rejects health text, unknown events, arbitrary identity and old/future timestamps", () => {
		const bad = [
			{ ...event, properties: { food: "private" } },
			{ ...event, name: "health_record" },
			{ ...event, subject: "other" },
			{ ...event, occurredAt: "2025-01-01T00:00:00Z" },
			{ ...event, occurredAt: "2026-10-20T13:00:00Z" },
			{ ...event, properties: { method: "private" } },
		];
		for (const item of bad) expect(() => validateBatch({ events: [item] }, spec, now)).toThrow();
	});
	it("rejects duplicate event IDs within one batch", () =>
		expect(() => validateBatch({ events: [event, event] }, spec, now)).toThrow());
	it("does not treat inherited object properties as approved event names", () =>
		expect(() =>
			validateBatch({ events: [{ ...event, name: "constructor" }] }, spec, now),
		).toThrow());
});
