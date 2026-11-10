import "server-only";
import type { ZodType } from "zod";
import { apiBase, type ConfiguredApp } from "./config";
import { analyticsQuery, type Filters } from "./policy";
import { analyticsSchema, appInfoSchema } from "./schema";

async function read<T>(app: ConfiguredApp, path: string, schema: ZodType<T>): Promise<T> {
	const response = await fetch(new URL(path, apiBase()), {
		headers: {
			Authorization: `Bearer ${app.apiKey}`,
			Accept: "application/json",
		},
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) throw new Error(`Analytics service returned ${response.status}.`);
	return schema.parse(await response.json());
}
export async function readDashboard(app: ConfiguredApp, filters: Filters) {
	const [analytics, info] = await Promise.all([
		read(app, `/v1/server/analytics?${analyticsQuery(filters)}`, analyticsSchema),
		read(app, "/v1/server/app", appInfoSchema),
	]);
	if (
		analytics.app.slug !== app.slug ||
		info.slug !== app.slug ||
		analytics.environment !== filters.environment
	) {
		throw new Error("Analytics response does not match the selected app or environment.");
	}
	return { analytics, eventNames: info.eventNames };
}
