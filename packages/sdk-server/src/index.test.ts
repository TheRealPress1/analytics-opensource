import { describe, expect, it, vi } from "vitest";
import { SubKitServer, SubKitServerError } from "./index.js";

const key = `sk_${"x".repeat(32)}`;
describe("server SDK", () => {
	it("issues a collector credential for the backend-authenticated subject", async () => {
		const credential = {
			token: "synthetic.token",
			subject: "synthetic_user",
			environment: "development",
			expiresAt: "2026-11-09T13:00:00Z",
		};
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(credential));
		const sdk = new SubKitServer({
			baseUrl: "https://analytics.example.test",
			secretKey: key,
			fetch: fetcher,
		});
		expect(await sdk.issueCollectorToken("synthetic_user", "development")).toEqual(credential);
		expect(fetcher.mock.calls[0]?.[0]).toBe("https://analytics.example.test/v1/server/sessions");
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
			subject: "synthetic_user",
			environment: "development",
		});
		expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
		expect(JSON.stringify(sdk)).not.toContain(key);
	});

	it("does not accept a session response for another account", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				token: "synthetic.token",
				subject: "another_user",
				environment: "development",
				expiresAt: "2026-11-09T13:00:00Z",
			}),
		);
		const sdk = new SubKitServer({
			baseUrl: "https://analytics.example.test",
			secretKey: key,
			fetch: fetcher,
		});
		await expect(sdk.issueCollectorToken("synthetic_user", "development")).rejects.toMatchObject({
			code: "invalid_collector_response",
		});
	});

	it("encodes range, environment and funnel query parameters", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
		const sdk = new SubKitServer({
			baseUrl: "https://analytics.example.test",
			secretKey: key,
			fetch: fetcher,
		});
		await sdk.getAnalytics({
			environment: "development",
			range: "all",
			funnel: ["app_opened", "feature_used"],
		});
		const url = new URL(String(fetcher.mock.calls[0]?.[0]));
		expect(url.searchParams.get("range")).toBe("all");
		expect(url.searchParams.get("environment")).toBe("development");
		expect(url.searchParams.get("funnel")).toBe("app_opened,feature_used");
	});

	it("deletes a subject through the protected endpoint", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ deleted: 4 }));
		const sdk = new SubKitServer({
			baseUrl: "https://analytics.example.test",
			secretKey: key,
			fetch: fetcher,
		});
		expect(await sdk.deleteSubject("synthetic_user")).toEqual({ deleted: 4 });
		expect(fetcher.mock.calls[0]?.[1]?.method).toBe("DELETE");
		expect(String(fetcher.mock.calls[0]?.[0]).endsWith("/v1/server/subjects/synthetic_user")).toBe(
			true,
		);
	});

	it("reports HTTP status without leaking response bodies or credentials", async () => {
		const sdk = new SubKitServer({
			baseUrl: "https://analytics.example.test",
			secretKey: key,
			fetch: vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response(`sensitive ${key}`, { status: 401 })),
		});
		const error = await sdk.getApp().catch((error: unknown) => error);
		expect(error).toBeInstanceOf(SubKitServerError);
		expect(String(error)).not.toContain(key);
		expect(error).toMatchObject({ status: 401 });
	});

	it("requires an isolated server context and secure API origin", () => {
		expect(() => new SubKitServer({ baseUrl: "http://example.test", secretKey: key })).toThrow(
			SubKitServerError,
		);
		expect(
			() => new SubKitServer({ baseUrl: "https://example.test", secretKey: "pk_public" }),
		).toThrow(SubKitServerError);
		vi.stubGlobal("window", {});
		try {
			expect(() => new SubKitServer({ baseUrl: "https://example.test", secretKey: key })).toThrow(
				"server_sdk_in_browser",
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
