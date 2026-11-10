export type Environment = "production" | "development";
export type PropertyRule =
	| { type: "boolean" }
	| { type: "number"; min: number; max: number }
	| { type: "enum"; values: string[] };
export type EventSpecs = Record<string, Record<string, PropertyRule>>;
export type Properties = Record<string, boolean | number | string>;
export interface CollectorToken {
	token: string;
	subject: string;
	environment: Environment;
	expiresAt: string;
}
export interface QueueStorage {
	read(key: string): string | null;
	write(key: string, value: string): void;
	remove(key: string): void;
}
export interface UsageEvent {
	id: string;
	name: string;
	occurredAt: string;
	sessionId: string;
	properties: Properties;
}
export interface DeliveryResult {
	accepted: number;
	duplicates: number;
	discarded: number;
	busy?: boolean;
	superseded?: boolean;
}
export interface AnalyticsOptions {
	baseUrl: string;
	appNamespace: string;
	subject: string;
	environment: Environment;
	eventSpecs: EventSpecs;
	tokenProvider: (signal: AbortSignal) => Promise<CollectorToken>;
	enabled?: boolean;
	storage?: QueueStorage;
	automaticFlush?: boolean;
	maxQueuedEvents?: number;
	allowLocalhostHttp?: boolean;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
	onDelivery?: (result: DeliveryResult) => void;
}
export class AnalyticsError extends Error {
	constructor(
		public readonly code: string,
		public readonly status?: number,
	) {
		super(status === undefined ? code : `${code} (${status})`);
		this.name = "AnalyticsError";
	}
}
const namePattern = /^[a-z][a-z0-9_]{0,63}$/;
const subjectPattern = /^[A-Za-z0-9_-]{8,128}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const week = 7 * 86_400_000;
const emptyResult = (): DeliveryResult => ({ accepted: 0, duplicates: 0, discarded: 0 });

export function memoryQueueStorage(): QueueStorage {
	const values = new Map<string, string>();
	return {
		read: (key) => values.get(key) ?? null,
		write: (key, value) => {
			values.set(key, value);
		},
		remove: (key) => {
			values.delete(key);
		},
	};
}

/** Opt in explicitly to persistence. localStorage has no access control against other page scripts. */
export function browserQueueStorage(
	storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): QueueStorage {
	return {
		read: (key) => storage.getItem(key),
		write: (key, value) => storage.setItem(key, value),
		remove: (key) => storage.removeItem(key),
	};
}

function apiBaseUrl(value: string, environment: Environment, local: boolean): string {
	const url = new URL(value);
	// Inspect the original path: URL normalizes dot segments before exposing pathname.
	const raw = /^https?:\/\/[^/?#\\\s]+(\/[^?#\\\s]*)?$/.exec(value);
	const path = raw?.[1] ?? "";
	const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		!raw ||
		raw[0] !== value ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && localhost && local && environment === "development")) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!/^(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(path) ||
		path.split("/").some((segment) => segment === "." || segment === "..")
	) {
		throw new AnalyticsError("invalid_api_origin");
	}
	return `${url.origin}${path.replace(/\/$/, "")}`;
}

function validateSpecs(specs: EventSpecs): void {
	const entries = Object.entries(specs);
	if (entries.length < 1 || entries.length > 100) throw new AnalyticsError("invalid_event_specs");
	for (const [name, properties] of entries) {
		if (!namePattern.test(name) || !properties || Object.keys(properties).length > 10)
			throw new AnalyticsError("invalid_event_specs");
		for (const [key, rule] of Object.entries(properties)) {
			if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) throw new AnalyticsError("invalid_property_spec");
			if (rule.type === "boolean") continue;
			if (
				rule.type === "number" &&
				Number.isFinite(rule.min) &&
				Number.isFinite(rule.max) &&
				rule.min <= rule.max
			)
				continue;
			if (
				rule.type === "enum" &&
				rule.values.length > 0 &&
				rule.values.length <= 30 &&
				rule.values.every((v) => typeof v === "string" && v.length > 0 && v.length <= 40)
			)
				continue;
			throw new AnalyticsError("invalid_property_spec");
		}
	}
}

function permitted(name: string, properties: Properties, specs: EventSpecs): boolean {
	if (!Object.hasOwn(specs, name)) return false;
	const rules = specs[name];
	if (!rules || !properties || Array.isArray(properties) || Object.keys(properties).length > 10)
		return false;
	return Object.entries(properties).every(([key, value]) => {
		if (!Object.hasOwn(rules, key)) return false;
		const rule = rules[key];
		return rule?.type === "boolean"
			? typeof value === "boolean"
			: rule?.type === "number"
				? typeof value === "number" &&
					Number.isFinite(value) &&
					value >= rule.min &&
					value <= rule.max
				: rule?.type === "enum"
					? typeof value === "string" && rule.values.includes(value)
					: false;
	});
}

/** No automatic screen capture, device fingerprinting, identity merging, billing or health payloads. */
export class AnalyticsClient {
	private readonly baseUrl: string;
	private readonly storage: QueueStorage;
	private readonly fetcher: typeof globalThis.fetch;
	private readonly now: () => number;
	private readonly maximum: number;
	private readonly automatic: boolean;
	private readonly specs: EventSpecs;
	private subject: string;
	private provider: AnalyticsOptions["tokenProvider"];
	private enabled: boolean;
	private scope = "";
	private events: UsageEvent[] = [];
	private sessionId = crypto.randomUUID();
	private lastActivity?: number;
	private generation = 0;
	private inFlight?: AbortController;
	private timer?: ReturnType<typeof setTimeout>;
	private retryAttempt = 0;

	private constructor(private readonly options: AnalyticsOptions) {
		if (!subjectPattern.test(options.subject)) throw new AnalyticsError("invalid_subject");
		if (!["development", "production"].includes(options.environment))
			throw new AnalyticsError("invalid_environment");
		if (!options.appNamespace || options.appNamespace.length > 128)
			throw new AnalyticsError("invalid_namespace");
		validateSpecs(options.eventSpecs);
		this.specs = structuredClone(options.eventSpecs);
		this.baseUrl = apiBaseUrl(
			options.baseUrl,
			options.environment,
			options.allowLocalhostHttp === true,
		);
		this.subject = options.subject;
		this.provider = options.tokenProvider;
		this.enabled = options.enabled === true;
		this.storage = options.storage ?? memoryQueueStorage();
		this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.now = options.now ?? Date.now;
		this.maximum = options.maxQueuedEvents ?? 500;
		if (!Number.isInteger(this.maximum) || this.maximum < 1 || this.maximum > 500)
			throw new AnalyticsError("invalid_queue_bound");
		this.automatic = options.automaticFlush !== false;
	}

	static async create(options: AnalyticsOptions): Promise<AnalyticsClient> {
		const client = new AnalyticsClient({
			...options,
			eventSpecs: structuredClone(options.eventSpecs),
		});
		client.scope = await client.scopeFor(options.subject);
		client.restore();
		client.schedule(0);
		return client;
	}

	get pendingEventCount(): number {
		return this.events.length;
	}
	get isEnabled(): boolean {
		return this.enabled;
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		if (!enabled) {
			this.invalidate();
			this.events = [];
			this.startSession();
			this.storage.remove(this.scope);
		} else this.schedule(0);
	}

	signOut(): void {
		this.setEnabled(false);
	}

	/** Call with the new account's authenticated token provider; old pending events are erased. */
	async setIdentity(
		subject: string,
		tokenProvider: AnalyticsOptions["tokenProvider"],
		enabled = false,
	): Promise<void> {
		if (!subjectPattern.test(subject)) throw new AnalyticsError("invalid_subject");
		this.invalidate();
		this.enabled = false;
		this.events = [];
		this.storage.remove(this.scope);
		const generation = this.generation;
		const scope = await this.scopeFor(subject);
		if (generation !== this.generation) return;
		this.subject = subject;
		this.scope = scope;
		this.provider = tokenProvider;
		this.startSession();
		this.storage.remove(this.scope);
		this.enabled = enabled;
		this.retryAttempt = 0;
	}

	startSession(): void {
		this.sessionId = crypto.randomUUID();
		this.lastActivity = undefined;
	}

	track(name: string, properties: Properties = {}): string | undefined {
		if (!this.enabled) return undefined;
		if (!permitted(name, properties, this.specs))
			throw new AnalyticsError("event_or_properties_not_allowed");
		const now = this.now();
		if (
			this.lastActivity !== undefined &&
			(now < this.lastActivity || now - this.lastActivity >= 30 * 60_000)
		)
			this.startSession();
		this.lastActivity = now;
		const event = {
			id: crypto.randomUUID(),
			name,
			occurredAt: new Date(now).toISOString(),
			sessionId: this.sessionId,
			properties: structuredClone(properties),
		};
		if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 4096)
			throw new AnalyticsError("event_too_large");
		const previous = this.events;
		this.events = [...this.fresh(this.events), event].slice(-this.maximum);
		try {
			this.persist();
		} catch (error) {
			this.events = previous;
			throw error;
		}
		this.schedule(1000);
		return event.id;
	}

	async flush(): Promise<DeliveryResult> {
		if (!this.enabled) return emptyResult();
		if (this.inFlight) return { ...emptyResult(), busy: true };
		this.cancelTimer();
		this.events = this.fresh(this.events);
		this.persist();
		if (!this.events.length) return emptyResult();
		const batch = this.events.slice(0, 50);
		let body = JSON.stringify({ events: batch });
		while (new TextEncoder().encode(body).byteLength > 60 * 1024) {
			batch.pop();
			body = JSON.stringify({ events: batch });
		}
		const generation = this.generation;
		const subject = this.subject;
		const controller = new AbortController();
		this.inFlight = controller;
		const timeout = setTimeout(() => controller.abort(), 15_000);
		try {
			const credential = await this.provider(controller.signal);
			if (generation !== this.generation || !this.enabled)
				return { ...emptyResult(), superseded: true };
			controller.signal.throwIfAborted();
			if (credential.subject !== subject) throw new AnalyticsError("token_subject_mismatch");
			if (credential.environment !== this.options.environment)
				throw new AnalyticsError("token_environment_mismatch");
			if (
				!Number.isFinite(Date.parse(credential.expiresAt)) ||
				Date.parse(credential.expiresAt) <= this.now() + 5000
			)
				throw new AnalyticsError("token_expired");
			if (!credential.token || credential.token.startsWith("sk_") || /\s/.test(credential.token))
				throw new AnalyticsError("invalid_collector_token");
			const response = await this.fetcher(`${this.baseUrl}/v1/events`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${credential.token}`,
				},
				body,
				signal: controller.signal,
				redirect: "error",
				credentials: "omit",
				cache: "no-store",
				referrerPolicy: "no-referrer",
			});
			if (generation !== this.generation || !this.enabled)
				return { ...emptyResult(), superseded: true };
			let result: DeliveryResult;
			if (response.status === 200) {
				const acknowledgment = (await response.json()) as {
					accepted?: unknown;
					duplicates?: unknown;
				};
				if (generation !== this.generation || !this.enabled)
					return { ...emptyResult(), superseded: true };
				if (
					typeof acknowledgment.accepted !== "number" ||
					typeof acknowledgment.duplicates !== "number" ||
					!Number.isSafeInteger(acknowledgment.accepted) ||
					!Number.isSafeInteger(acknowledgment.duplicates) ||
					acknowledgment.accepted < 0 ||
					acknowledgment.duplicates < 0 ||
					acknowledgment.accepted + acknowledgment.duplicates !== batch.length
				)
					throw new AnalyticsError("invalid_acknowledgment");
				result = {
					accepted: acknowledgment.accepted,
					duplicates: acknowledgment.duplicates,
					discarded: 0,
				};
			} else if (
				response.status >= 400 &&
				response.status < 500 &&
				response.status !== 401 &&
				response.status !== 408 &&
				response.status !== 429
			) {
				result = { ...emptyResult(), discarded: batch.length };
			} else {
				const retryAfter = Number(response.headers.get("Retry-After"));
				this.retry(Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
				throw new AnalyticsError("http_error", response.status);
			}
			this.remove(batch);
			this.retryAttempt = 0;
			this.schedule(0);
			this.options.onDelivery?.(result);
			return result;
		} catch (error) {
			if (generation !== this.generation || !this.enabled)
				return { ...emptyResult(), superseded: true };
			if (this.timer === undefined) this.retry();
			throw error;
		} finally {
			clearTimeout(timeout);
			if (generation === this.generation) this.inFlight = undefined;
		}
	}

	/** Ends retry timers but preserves pending events for the same-account next launch. */
	dispose(): void {
		this.invalidate();
		this.enabled = false;
	}

	private async scopeFor(subject: string): Promise<string> {
		const input = JSON.stringify([
			this.baseUrl,
			this.options.appNamespace,
			this.options.environment,
			subject,
		]);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
		return `subkit:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
	}

	private restore(): void {
		if (!this.enabled) {
			this.storage.remove(this.scope);
			return;
		}
		const saved = this.storage.read(this.scope);
		if (saved === null) return;
		if (saved.length > 4 * 1024 * 1024) throw new AnalyticsError("invalid_stored_queue");
		let envelope: { version: number; scope: string; events: UsageEvent[] };
		try {
			envelope = JSON.parse(saved);
		} catch {
			throw new AnalyticsError("invalid_stored_queue");
		}
		if (
			envelope.version !== 1 ||
			envelope.scope !== this.scope ||
			!Array.isArray(envelope.events) ||
			envelope.events.length > 500
		)
			throw new AnalyticsError("invalid_stored_queue");
		const seen = new Set<string>();
		const restored = envelope.events
			.filter((event) => {
				if (
					!event ||
					!uuidPattern.test(event.id) ||
					!uuidPattern.test(event.sessionId) ||
					seen.has(event.id) ||
					!permitted(event.name, event.properties, this.specs)
				)
					return false;
				seen.add(event.id);
				return true;
			})
			.map(({ id, name, occurredAt, sessionId, properties }) => ({
				id,
				name,
				occurredAt,
				sessionId,
				properties,
			}));
		this.events = this.fresh(restored).slice(-this.maximum);
		this.persist();
	}

	private fresh(events: UsageEvent[]): UsageEvent[] {
		const now = this.now();
		return events.filter(
			(event) => Date.parse(event.occurredAt) > now - week && Date.parse(event.occurredAt) <= now,
		);
	}

	private persist(): void {
		if (this.events.length)
			this.storage.write(
				this.scope,
				JSON.stringify({ version: 1, scope: this.scope, events: this.events }),
			);
		else this.storage.remove(this.scope);
	}

	private remove(batch: UsageEvent[]): void {
		const ids = new Set(batch.map((event) => event.id));
		const previous = this.events;
		this.events = this.events.filter((event) => !ids.has(event.id));
		try {
			this.persist();
		} catch (error) {
			this.events = previous;
			throw error;
		}
	}

	private invalidate(): void {
		this.generation++;
		this.cancelTimer();
		this.inFlight?.abort();
		this.inFlight = undefined;
	}
	private cancelTimer(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}
	private retry(retryAfter = 0): void {
		this.retryAttempt = Math.min(this.retryAttempt + 1, 12);
		this.schedule(
			Math.max(
				Math.min(3_600_000, 1000 * 2 ** this.retryAttempt),
				Math.min(Math.max(retryAfter, 0), 3_600_000),
			),
		);
	}
	private schedule(milliseconds: number): void {
		if (!this.automatic || !this.enabled || !this.events.length || this.timer !== undefined) return;
		const generation = this.generation;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (generation === this.generation) void this.flush().catch(() => {});
		}, milliseconds);
	}
}
