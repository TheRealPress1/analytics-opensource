import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyManagementServiceClient } from "@google-cloud/kms";
import { describe, expect, it, vi } from "vitest";
import {
	crc32c,
	decryptEnvelope,
	type EncryptionContext,
	encryptEnvelope,
	googleKmsKeyWrapper,
	type KeyWrapper,
} from "./index.js";

const context: EncryptionContext = {
	appId: "synthetic-app",
	environment: "development",
	purpose: "fixture",
	recordId: "record-1",
};
function testWrapper(): KeyWrapper {
	const kek = randomBytes(32);
	const keyName = "projects/test/locations/us-east4/keyRings/subkit/cryptoKeys/credentials-kek";
	return {
		keyName,
		async wrap(key, aad) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", kek, iv);
			cipher.setAAD(aad);
			return {
				ciphertext: Buffer.concat([iv, cipher.update(key), cipher.final(), cipher.getAuthTag()]),
				keyVersion: `${keyName}/cryptoKeyVersions/1`,
			};
		},
		async unwrap(ciphertext, aad) {
			const value = Buffer.from(ciphertext);
			const decipher = createDecipheriv("aes-256-gcm", kek, value.subarray(0, 12));
			decipher.setAAD(aad);
			decipher.setAuthTag(value.subarray(-16));
			return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]);
		},
	};
}
describe("envelope encryption", () => {
	it("round-trips arbitrary bytes and empty data without storing a plaintext key", async () => {
		const wrapper = testWrapper();
		for (const plaintext of [
			Buffer.alloc(0),
			Buffer.from([0, 1, 255]),
			Buffer.from("synthetic secret"),
		]) {
			const envelope = await encryptEnvelope(plaintext, context, wrapper);
			expect(await decryptEnvelope(envelope, context, wrapper)).toEqual(plaintext);
			expect(Object.keys(envelope).sort()).toEqual(
				[
					"algorithm",
					"ciphertext",
					"iv",
					"keyName",
					"keyVersion",
					"tag",
					"version",
					"wrappedKey",
				].sort(),
			);
		}
	});
	it("uses independent data keys and nonces", async () => {
		const wrapper = testWrapper();
		const a = await encryptEnvelope(Buffer.from("same"), context, wrapper);
		const b = await encryptEnvelope(Buffer.from("same"), context, wrapper);
		expect(a.iv).not.toBe(b.iv);
		expect(a.wrappedKey).not.toBe(b.wrappedKey);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});
	it.each(["appId", "environment", "purpose", "recordId"] as const)(
		"rejects cross-context %s substitution",
		async (field) => {
			const wrapper = testWrapper();
			const envelope = await encryptEnvelope(Buffer.from("secret"), context, wrapper);
			const other = {
				...context,
				[field]: field === "environment" ? "production" : "different",
			} as EncryptionContext;
			await expect(decryptEnvelope(envelope, other, wrapper)).rejects.toThrow();
		},
	);
	it.each(["wrappedKey", "iv", "ciphertext", "tag"] as const)(
		"rejects tampered %s",
		async (field) => {
			const wrapper = testWrapper();
			const envelope = await encryptEnvelope(Buffer.from("secret"), context, wrapper);
			const value = Buffer.from(envelope[field], "base64");
			value[0] = (value[0] ?? 0) ^ 1;
			await expect(
				decryptEnvelope({ ...envelope, [field]: value.toString("base64") }, context, wrapper),
			).rejects.toThrow();
		},
	);
	it("authenticates the recorded wrapping key version", async () => {
		const wrapper = testWrapper();
		const envelope = await encryptEnvelope(Buffer.from("secret"), context, wrapper);
		await expect(
			decryptEnvelope(
				{ ...envelope, keyVersion: `${wrapper.keyName}/cryptoKeyVersions/99` },
				context,
				wrapper,
			),
		).rejects.toThrow();
	});

	it("rejects foreign key names before calling KMS", async () => {
		const wrapper = testWrapper();
		const envelope = await encryptEnvelope(Buffer.from("secret"), context, wrapper);
		await expect(
			decryptEnvelope({ ...envelope, keyName: "untrusted" }, context, wrapper),
		).rejects.toThrow("Unsupported");
	});
	it("rejects unsupported formats, invalid base64, oversized data and invalid context", async () => {
		const wrapper = testWrapper();
		const envelope = await encryptEnvelope(Buffer.from("secret"), context, wrapper);
		await expect(decryptEnvelope({ ...envelope, iv: "!!!!" }, context, wrapper)).rejects.toThrow(
			"encoding",
		);
		await expect(encryptEnvelope(Buffer.alloc(1024 * 1024 + 1), context, wrapper)).rejects.toThrow(
			"limit",
		);
		await expect(
			encryptEnvelope(Buffer.alloc(0), { ...context, appId: "" }, wrapper),
		).rejects.toThrow("context");
		expect(() => googleKmsKeyWrapper("untrusted")).toThrow("CryptoKey");
	});
	it("matches standard CRC32C vectors", () => {
		expect(crc32c(Buffer.alloc(0))).toBe(0);
		expect(crc32c(Buffer.from("123456789"))).toBe(0xe3069283);
	});
});

describe("Google KMS transport integrity", () => {
	const keyName = "projects/test/locations/us-east4/keyRings/subkit/cryptoKeys/credentials-kek";
	function fakeClient(overrides: Record<string, unknown> = {}) {
		const ciphertext = Buffer.from("wrapped-data");
		const plaintext = Buffer.alloc(32, 7);
		return {
			encrypt: vi.fn(async (_request: unknown) => [
				{
					name: `${keyName}/cryptoKeyVersions/2`,
					ciphertext,
					verifiedPlaintextCrc32c: true,
					verifiedAdditionalAuthenticatedDataCrc32c: true,
					ciphertextCrc32c: { value: crc32c(ciphertext) },
					...overrides,
				},
			]),
			decrypt: vi.fn(async (_request: unknown) => [
				{
					plaintext,
					plaintextCrc32c: { value: crc32c(plaintext) },
					...overrides,
				},
			]),
		};
	}
	it("sends checksum fields and verifies authenticated response", async () => {
		const client = fakeClient();
		const wrapper = googleKmsKeyWrapper(keyName, client as unknown as KeyManagementServiceClient);
		const key = Buffer.alloc(32, 1);
		const aad = Buffer.from("context");
		expect((await wrapper.wrap(key, aad)).keyVersion).toBe(`${keyName}/cryptoKeyVersions/2`);
		expect(client.encrypt.mock.calls[0]?.[0]).toMatchObject({
			plaintextCrc32c: { value: crc32c(key) },
			additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
		});
		expect((await wrapper.unwrap(Buffer.from("wrapped"), aad)).length).toBe(32);
	});
	it.each([
		{ verifiedPlaintextCrc32c: false },
		{ verifiedAdditionalAuthenticatedDataCrc32c: false },
		{ ciphertextCrc32c: { value: 1 } },
		{ name: "foreign-key" },
	])("fails closed on invalid encrypt integrity %j", async (overrides) => {
		const wrapper = googleKmsKeyWrapper(
			keyName,
			fakeClient(overrides) as unknown as KeyManagementServiceClient,
		);
		await expect(wrapper.wrap(Buffer.alloc(32), Buffer.from("context"))).rejects.toThrow(
			"integrity",
		);
	});
	it("fails closed on invalid decrypt checksum", async () => {
		const wrapper = googleKmsKeyWrapper(
			keyName,
			fakeClient({
				plaintextCrc32c: { value: 1 },
			}) as unknown as KeyManagementServiceClient,
		);
		await expect(wrapper.unwrap(Buffer.from("wrapped"), Buffer.from("context"))).rejects.toThrow(
			"integrity",
		);
	});
});
