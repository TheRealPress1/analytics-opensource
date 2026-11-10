import { type AnalyticsEvent, analyze } from "@subkit/core";
import type { Filters } from "./policy";
import type { Analytics } from "./schema";

export const demoApp = {
	id: "demo-only",
	slug: "demo-app",
	name: "Example app",
};
export const demoEventNames = [
	"app_opened",
	"onboarding_completed",
	"project_created",
	"project_shared",
];

/** Invented people and events only. Generated deterministically; never merges with an API response. */
export function demoAnalytics(filters: Filters, now = new Date()): Analytics {
	const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
	const start = today - 89 * 86400000;
	const events: AnalyticsEvent[] = [];
	for (let day = 0; day < 90; day++) {
		for (let person = 0; person < 48; person++) {
			const joined = person % 24;
			if (day < joined || (day + person * 3) % 7 > 3 || (day > 45 && person % 9 === 0)) continue;
			const subject = `fictional-${person}`;
			const sessionId = `fictional-session-${day}-${person}`;
			const base = start + day * 86400000 + (7 + (person % 10)) * 3600000;
			for (const [step, name] of demoEventNames.entries()) {
				if (step === 1 && day !== joined) continue;
				if (step === 2 && person % 4 === 0) continue;
				if (step === 3 && person % 5 !== 0) continue;
				const occurredAt = new Date(base + step * 120000).toISOString();
				if (Date.parse(occurredAt) > now.getTime()) continue;
				events.push({
					subject,
					sessionId,
					name,
					occurredAt,
				});
			}
		}
	}
	const from = filters.range === "all" ? new Date(start).toISOString().slice(0, 10) : filters.from;
	return {
		...analyze(events, from, filters.to, now, filters.funnel, filters.event),
		app: demoApp,
		environment: filters.environment,
	};
}
