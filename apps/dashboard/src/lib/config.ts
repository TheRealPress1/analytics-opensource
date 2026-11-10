import "server-only";
import { z } from "zod";
import { allowlist } from "./policy";

const appsSchema = z
	.array(
		z
			.object({
				name: z.string().min(1).max(100),
				slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
				apiKey: z.string().startsWith("sk_").min(20),
			})
			.strict(),
	)
	.min(1)
	.max(100)
	.refine((apps) => new Set(apps.map((a) => a.slug)).size === apps.length);
export type ConfiguredApp = z.infer<typeof appsSchema>[number];
export function authConfigured(): boolean {
	const list = allowlist(process.env);
	return Boolean(
		process.env.AUTH_GITHUB_ID &&
			process.env.AUTH_GITHUB_SECRET &&
			process.env.AUTH_SECRET &&
			(list.ids.length || list.emails.length),
	);
}
export function configuredApps(): ConfiguredApp[] {
	try {
		return appsSchema.parse(JSON.parse(process.env.SUBKIT_APPS_JSON ?? "[]"));
	} catch {
		throw new Error("Dashboard app configuration is missing or invalid.");
	}
}
export function apiBase(): URL {
	let url: URL;
	try {
		url = new URL(process.env.SUBKIT_API_URL ?? "");
	} catch {
		throw new Error("Dashboard API address is missing or invalid.");
	}
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol !== "https:" &&
			!(process.env.NODE_ENV !== "production" && local && url.protocol === "http:"))
	) {
		throw new Error("Dashboard API address must use HTTPS.");
	}
	return url;
}
