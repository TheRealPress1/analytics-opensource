export type Environment = "production" | "development";
export interface CollectorToken {
	token: string;
	subject: string;
	environment: Environment;
	expiresAt: string;
}
export interface AppInfo {
	id: string;
	name: string;
	slug: string;
	eventNames: string[];
}
export interface AnalyticsQuery {
	from?: string;
	to?: string;
	range?: "all";
	environment: Environment;
	event?: string;
	funnel?: string[];
}
export interface AnalyticsOverview {
	app: { id: string; name: string; slug: string };
	environment: Environment;
	from: string;
	to: string;
	generatedAt: string;
	totals: {
		events: number;
		activeUsers: number;
		sessions: number;
		eventsToday: number;
		activeToday: number;
		active7Days: number;
		active30Days: number;
	};
	daily: { date: string; events: number; activeUsers: number; sessions: number }[];
	topEvents: { name: string; count: number; users: number }[];
	retention: {
		cohortDate: string;
		users: number;
		day1: number | null;
		day7: number | null;
		day30: number | null;
	}[];
	funnel: { name: string; users: number; conversionRate: number | null }[];
	coverage: { firstEventAt: string | null; lastEventAt: string | null };
}
export interface ServerOptions {
	baseUrl: string;
	secretKey: string;
	allowLocalhostHttp?: boolean;
	fetch?: typeof globalThis.fetch;
}
export class SubKitServerError extends Error {
	constructor(
		public readonly code: string,
		public readonly status?: number,
	) {
		super(status === undefined ? code : `${code} (${status})`);
		this.name = "SubKitServerError";
	}
}
const subjectPattern = /^[A-Za-z0-9_-]{8,128}$/;

/** Server-only client. Host applications authenticate users before issuing collector tokens. */
export class SubKitServer {
	private readonly baseUrl: string;
	private readonly fetcher: typeof globalThis.fetch;
	readonly #secretKey: string;

	constructor(options: ServerOptions) {
		if (typeof window !== "undefined") throw new SubKitServerError("server_sdk_in_browser");
		if (!/^sk_[A-Za-z0-9_-]{24,}$/.test(options.secretKey))
			throw new SubKitServerError("invalid_server_key");
		const url = new URL(options.baseUrl);
		// Validate before relying on URL.pathname, which collapses traversal segments.
		const raw = /^https?:\/\/[^/?#\\\s]+(\/[^?#\\\s]*)?$/.exec(options.baseUrl);
		const path = raw?.[1] ?? "";
		const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (
			!raw ||
			raw[0] !== options.baseUrl ||
			(url.protocol !== "https:" &&
				!(url.protocol === "http:" && localhost && options.allowLocalhostHttp)) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!/^(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(path) ||
			path.split("/").some((segment) => segment === "." || segment === "..")
		)
			throw new SubKitServerError("invalid_api_origin");
		this.baseUrl = `${url.origin}${path.replace(/\/$/, "")}`;
		this.#secretKey = options.secretKey;
		this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	getApp(signal?: AbortSignal): Promise<AppInfo> {
		return this.request("GET", "/v1/server/app", undefined, signal);
	}

	async issueCollectorToken(
		subject: string,
		environment: Environment,
		signal?: AbortSignal,
	): Promise<CollectorToken> {
		this.validateSubject(subject);
		if (!["development", "production"].includes(environment))
			throw new SubKitServerError("invalid_environment");
		const credential = await this.request<CollectorToken>(
			"POST",
			"/v1/server/sessions",
			{ subject, environment },
			signal,
		);
		if (
			credential.subject !== subject ||
			credential.environment !== environment ||
			typeof credential.token !== "string" ||
			!Number.isFinite(Date.parse(credential.expiresAt))
		)
			throw new SubKitServerError("invalid_collector_response");
		return credential;
	}

	getAnalytics(query: AnalyticsQuery, signal?: AbortSignal): Promise<AnalyticsOverview> {
		if (!["development", "production"].includes(query.environment))
			throw new SubKitServerError("invalid_environment");
		const parameters = new URLSearchParams({ environment: query.environment });
		for (const key of ["from", "to", "range", "event"] as const)
			if (query[key]) parameters.set(key, query[key]);
		if (query.funnel?.length) {
			if (
				query.funnel.length > 8 ||
				query.funnel.some((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name))
			)
				throw new SubKitServerError("invalid_funnel");
			parameters.set("funnel", query.funnel.join(","));
		}
		return this.request("GET", `/v1/server/analytics?${parameters}`, undefined, signal);
	}

	/** Deletes this subject's events across environments and prevents collector token reissuance. */
	async deleteSubject(subject: string, signal?: AbortSignal): Promise<{ deleted: number }> {
		this.validateSubject(subject);
		const result = await this.request<{ deleted: number }>(
			"DELETE",
			`/v1/server/subjects/${encodeURIComponent(subject)}`,
			undefined,
			signal,
		);
		if (!Number.isSafeInteger(result.deleted) || result.deleted < 0)
			throw new SubKitServerError("invalid_delete_response");
		return result;
	}

	private validateSubject(subject: string): void {
		if (!subjectPattern.test(subject)) throw new SubKitServerError("invalid_subject");
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		const controller = new AbortController();
		const cancel = () => controller.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) controller.abort();
		const timeout = setTimeout(cancel, 15_000);
		try {
			const response = await this.fetcher(`${this.baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.#secretKey}`,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: controller.signal,
				redirect: "error",
				cache: "no-store",
				credentials: "omit",
			});
			if (!response.ok) throw new SubKitServerError("http_error", response.status);
			try {
				return (await response.json()) as T;
			} catch {
				throw new SubKitServerError("invalid_json_response");
			}
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", cancel);
		}
	}
}
