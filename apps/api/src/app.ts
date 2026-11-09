import { analyze, dateKey, environmentSchema, ValidationError, validateBatch } from "@subkit/core";
import { type App, CapacityError, ConflictError, type Repository } from "@subkit/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

export function createApi({
	repo,
	tokenSecret,
	now = () => new Date(),
}: {
	repo: Repository;
	tokenSecret: Uint8Array;
	now?: () => Date;
}) {
	if (tokenSecret.byteLength < 32)
		throw new Error("Collector signing key must contain at least 256 bits");
	const app = new Hono();
	const failure = (code: string, message: string) => ({ error: { code, message } });
	app.use("*", secureHeaders());
	app.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	// Registered browser origins can read authentication/size failures as HTTP errors.
	// This never authenticates a caller; intake below still checks its token's own app.
	app.use("/v1/events", async (c, next) => {
		const origin = c.req.header("Origin");
		c.header("Vary", "Origin");
		if (origin && origin.length <= 2048 && (await repo.allowedOrigin(origin)))
			c.header("Access-Control-Allow-Origin", origin);
		await next();
	});
	app.use(
		"/v1/*",
		bodyLimit({
			maxSize: 65_536,
			onError: (c) => c.json(failure("body_too_large", "Maximum request size is 64 KiB"), 413),
		}),
	);
	const bearer = (header: string | undefined) =>
		header?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1] ?? "";
	const serverApp = async (header: string | undefined): Promise<App | null> => {
		const key = bearer(header);
		return key.startsWith("sk_") ? repo.appByKey(key) : null;
	};
	app.get("/healthz", (c) => c.json({ status: "ok" }));
	app.get("/readyz", async (c) => {
		try {
			await repo.health();
			return c.json({ status: "ready" });
		} catch {
			return c.json(failure("not_ready", "Database is not ready"), 503);
		}
	});
	app.post("/v1/server/sessions", async (c) => {
		const owner = await serverApp(c.req.header("Authorization"));
		if (!owner) return c.json(failure("unauthorized", "Server key required"), 401);
		if (!(await repo.consumeRate(`sessions:${owner.id}`, 1200, now())))
			return c.json(failure("rate_limited", "Retry in one minute"), 429, { "Retry-After": "60" });
		const body = z
			.object({
				subject: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
				environment: environmentSchema,
			})
			.strict()
			.parse(await c.req.json());
		if (await repo.isSubjectDeleted(owner.id, body.subject))
			return c.json(failure("subject_deleted", "Use a new identity after deletion"), 410);
		const expiresAt = new Date(now().getTime() + 15 * 60_000);
		const token = await new SignJWT({
			appId: owner.id,
			environment: body.environment,
			kind: "collector",
		})
			.setProtectedHeader({ alg: "HS256", typ: "JWT" })
			.setIssuer("subkit")
			.setAudience("subkit:events")
			.setSubject(body.subject)
			.setIssuedAt(Math.floor(now().getTime() / 1000))
			.setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
			.sign(tokenSecret);
		return c.json({
			token,
			expiresAt: expiresAt.toISOString(),
			subject: body.subject,
			environment: body.environment,
		});
	});
	// Only the registered origins above receive Access-Control-Allow-Origin.
	app.options("/v1/events", (c) => {
		c.header("Access-Control-Allow-Methods", "POST");
		c.header("Access-Control-Allow-Headers", "Authorization,Content-Type");
		c.header("Access-Control-Max-Age", "600");
		return c.body(null, 204);
	});
	app.post("/v1/events", async (c) => {
		let claims: { appId: string; subject: string; environment: "production" | "development" };
		try {
			const { payload } = await jwtVerify(bearer(c.req.header("Authorization")), tokenSecret, {
				issuer: "subkit",
				audience: "subkit:events",
				algorithms: ["HS256"],
				currentDate: now(),
				maxTokenAge: "15m",
			});
			const parsed = z
				.object({
					appId: z.uuid(),
					sub: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
					environment: environmentSchema,
					kind: z.literal("collector"),
				})
				.parse(payload);
			claims = { appId: parsed.appId, subject: parsed.sub, environment: parsed.environment };
		} catch {
			return c.json(failure("unauthorized", "Valid collector token required"), 401);
		}
		const owner = await repo.appById(claims.appId);
		if (!owner) return c.json(failure("unauthorized", "Unknown app"), 401);
		const origin = c.req.header("Origin");
		if (origin && !owner.allowedOrigins.includes(origin))
			return c.json(failure("origin_not_allowed", "Origin not registered for this app"), 403);
		if (origin) {
			c.header("Access-Control-Allow-Origin", origin);
			c.header("Vary", "Origin");
		}
		if (await repo.isSubjectDeleted(owner.id, claims.subject))
			return c.json(failure("subject_deleted", "Collection disabled for this identity"), 410);
		const rateOk =
			(await repo.consumeRate(`app:${owner.id}`, 6000, now())) &&
			(await repo.consumeRate(`collector:${owner.id}:${claims.subject}`, 120, now()));
		if (!rateOk)
			return c.json(failure("rate_limited", "Retry in one minute"), 429, { "Retry-After": "60" });
		const batch = validateBatch(await c.req.json(), owner.eventSpecs, now());
		return c.json(await repo.ingest(owner.id, claims.subject, claims.environment, batch));
	});
	app.get("/v1/server/app", async (c) => {
		const owner = await serverApp(c.req.header("Authorization"));
		if (!owner) return c.json(failure("unauthorized", "Server key required"), 401);
		return c.json({
			id: owner.id,
			name: owner.name,
			slug: owner.slug,
			eventNames: Object.keys(owner.eventSpecs),
		});
	});
	app.get("/v1/server/analytics", async (c) => {
		const owner = await serverApp(c.req.header("Authorization"));
		if (!owner) return c.json(failure("unauthorized", "Server key required"), 401);
		if (!(await repo.consumeRate(`analytics:${owner.id}`, 120, now())))
			return c.json(failure("rate_limited", "Retry in one minute"), 429, { "Retry-After": "60" });
		const environment = environmentSchema.parse(c.req.query("environment") ?? "production");
		const history = await repo.history(owner.id, environment);
		const to = c.req.query("to") ?? dateKey(now());
		const firstObserved = history.find((event) => Date.parse(event.occurredAt) <= now().getTime());
		const from =
			c.req.query("range") === "all"
				? firstObserved
					? dateKey(new Date(firstObserved.occurredAt))
					: to
				: (c.req.query("from") ?? dateKey(new Date(now().getTime() - 29 * 86_400_000)));
		const funnel = c.req.query("funnel")?.split(",").filter(Boolean) ?? [];
		const event = c.req.query("event");
		if (
			[...funnel, ...(event ? [event] : [])].some((name) => !Object.hasOwn(owner.eventSpecs, name))
		)
			throw new ValidationError("Unknown event filter");
		return c.json({
			app: { id: owner.id, name: owner.name, slug: owner.slug },
			environment,
			...analyze(history, from, to, now(), funnel, event),
		});
	});
	app.get("/v1/server/events", async (c) => {
		const owner = await serverApp(c.req.header("Authorization"));
		if (!owner) return c.json(failure("unauthorized", "Server key required"), 401);
		const environment = environmentSchema.parse(c.req.query("environment") ?? "production");
		const limit = z.coerce
			.number()
			.int()
			.min(1)
			.max(100)
			.parse(c.req.query("limit") ?? 50);
		return c.json({ events: await repo.latest(owner.id, environment, limit) });
	});
	app.delete("/v1/server/subjects/:subject", async (c) => {
		const owner = await serverApp(c.req.header("Authorization"));
		if (!owner) return c.json(failure("unauthorized", "Server key required"), 401);
		const subject = z
			.string()
			.regex(/^[A-Za-z0-9_-]{8,128}$/)
			.parse(c.req.param("subject"));
		return c.json({ deleted: await repo.deleteSubject(owner.id, subject) });
	});
	app.notFound((c) => c.json(failure("not_found", "Endpoint not found"), 404));
	app.onError((error, c) => {
		if (
			error instanceof z.ZodError ||
			error instanceof ValidationError ||
			error instanceof SyntaxError
		)
			return c.json(
				failure(
					"invalid_request",
					error instanceof ValidationError ? error.message : "Request does not match the schema",
				),
				400,
			);
		if (error instanceof ConflictError)
			return c.json(failure("idempotency_conflict", error.message), 409);
		if (error instanceof CapacityError)
			return c.json(failure("history_capacity", error.message), 422);
		return c.json(failure("service_unavailable", "Please retry later"), 503);
	});
	return app;
}
