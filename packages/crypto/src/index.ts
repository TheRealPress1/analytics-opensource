import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";

/** Context binds ciphertext to its intended tenant and record, preventing row swaps. */
export interface EncryptionContext {
	appId: string;
	environment: "production" | "development";
	purpose: string;
	recordId: string;
}
export interface WrappedKey {
	ciphertext: Uint8Array;
	keyVersion: string;
}
export interface KeyWrapper {
	readonly keyName: string;
	wrap(key: Uint8Array, aad: Uint8Array): Promise<WrappedKey>;
	unwrap(ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}
export interface EncryptedEnvelope {
	version: 1;
	algorithm: "AES-256-GCM";
	keyName: string;
	keyVersion: string;
	wrappedKey: string;
	iv: string;
	ciphertext: string;
	tag: string;
}
const maxPlaintextBytes = 1024 * 1024;
function associatedData(context: EncryptionContext): Buffer {
	if (!context) throw new Error("Invalid encryption context");
	for (const value of [context.appId, context.environment, context.purpose, context.recordId]) {
		if (typeof value !== "string" || value.length === 0 || value.length > 256) {
			throw new Error("Invalid encryption context");
		}
	}
	if (!["production", "development"].includes(context.environment))
		throw new Error("Invalid environment");
	return Buffer.from(
		JSON.stringify([
			"subkit-envelope-v1",
			context.appId,
			context.environment,
			context.purpose,
			context.recordId,
		]),
	);
}
function decode(value: unknown, maxBytes: number, exactBytes?: number): Buffer {
	if (
		typeof value !== "string" ||
		value.length > Math.ceil(maxBytes / 3) * 4 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		throw new Error("Invalid envelope encoding");
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.length > maxBytes || (exactBytes !== undefined && decoded.length !== exactBytes))
		throw new Error("Invalid envelope length");
	return decoded;
}
export async function encryptEnvelope(
	plaintext: Uint8Array,
	context: EncryptionContext,
	wrapper: KeyWrapper,
): Promise<EncryptedEnvelope> {
	if (plaintext.byteLength > maxPlaintextBytes) throw new Error("Plaintext exceeds limit");
	const aad = associatedData(context);
	const key = randomBytes(32);
	try {
		const wrapped = await wrapper.wrap(key, aad);
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(Buffer.concat([aad, Buffer.from(`\0${wrapped.keyVersion}`)]));
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return {
			version: 1,
			algorithm: "AES-256-GCM",
			keyName: wrapper.keyName,
			keyVersion: wrapped.keyVersion,
			wrappedKey: Buffer.from(wrapped.ciphertext).toString("base64"),
			iv: iv.toString("base64"),
			ciphertext: ciphertext.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
		};
	} finally {
		key.fill(0);
	}
}
export async function decryptEnvelope(
	envelope: EncryptedEnvelope,
	context: EncryptionContext,
	wrapper: KeyWrapper,
): Promise<Buffer> {
	if (
		envelope?.version !== 1 ||
		envelope.algorithm !== "AES-256-GCM" ||
		envelope.keyName !== wrapper.keyName ||
		typeof envelope.keyVersion !== "string" ||
		!envelope.keyVersion.startsWith(`${wrapper.keyName}/cryptoKeyVersions/`)
	) {
		throw new Error("Unsupported envelope or key");
	}
	const aad = associatedData(context);
	const wrapped = decode(envelope.wrappedKey, 8192);
	const iv = decode(envelope.iv, 12, 12);
	const tag = decode(envelope.tag, 16, 16);
	const ciphertext = decode(envelope.ciphertext, maxPlaintextBytes);
	const unwrapped = await wrapper.unwrap(wrapped, aad);
	const key = Buffer.from(unwrapped);
	unwrapped.fill(0);
	try {
		if (key.length !== 32) throw new Error("Invalid data key");
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAAD(Buffer.concat([aad, Buffer.from(`\0${envelope.keyVersion}`)]));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} finally {
		key.fill(0);
	}
}

/** Castagnoli CRC32C for Cloud KMS request/response transport-integrity fields. */
export function crc32c(value: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of value) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function bytes(value: Uint8Array | string | null | undefined): Buffer {
	if (value === null || value === undefined) throw new Error("KMS returned no data");
	return typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value);
}
/** Uses attached service identity / ADC. No exported service-account key or master key. */
export function googleKmsKeyWrapper(
	keyName: string,
	client = new KeyManagementServiceClient(),
): KeyWrapper {
	if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(keyName))
		throw new Error("Expected a CryptoKey resource name");
	return {
		keyName,
		async wrap(key, aad) {
			const [response] = await client.encrypt({
				name: keyName,
				plaintext: key,
				plaintextCrc32c: { value: crc32c(key) },
				additionalAuthenticatedData: aad,
				additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
			});
			const ciphertext = bytes(response.ciphertext);
			if (
				!response.verifiedPlaintextCrc32c ||
				!response.verifiedAdditionalAuthenticatedDataCrc32c ||
				Number(response.ciphertextCrc32c?.value) !== crc32c(ciphertext) ||
				!response.name?.startsWith(`${keyName}/cryptoKeyVersions/`)
			)
				throw new Error("KMS encryption integrity check failed");
			return { ciphertext, keyVersion: response.name };
		},
		async unwrap(ciphertext, aad) {
			const [response] = await client.decrypt({
				name: keyName,
				ciphertext,
				ciphertextCrc32c: { value: crc32c(ciphertext) },
				additionalAuthenticatedData: aad,
				additionalAuthenticatedDataCrc32c: { value: crc32c(aad) },
			});
			const plaintext = bytes(response.plaintext);
			if (Number(response.plaintextCrc32c?.value) !== crc32c(plaintext)) {
				plaintext.fill(0);
				throw new Error("KMS decryption integrity check failed");
			}
			return plaintext;
		},
	};
}
