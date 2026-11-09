import { randomBytes, timingSafeEqual } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { decryptEnvelope, encryptEnvelope, googleKmsKeyWrapper } from "./index.js";

const keyName = process.env.SUBKIT_KMS_KEY_NAME;
if (!keyName) throw new Error("SUBKIT_KMS_KEY_NAME is required");
const context = {
	appId: "synthetic-acceptance",
	environment: "development" as const,
	purpose: "kms-readiness",
	recordId: "ephemeral-probe",
};
const original = randomBytes(32);
const client = new KeyManagementServiceClient();
const wrapper = googleKmsKeyWrapper(keyName, client);
try {
	const envelope = await encryptEnvelope(original, context, wrapper);
	const decrypted = await decryptEnvelope(envelope, context, wrapper);
	try {
		if (!timingSafeEqual(original, decrypted)) throw new Error("KMS round-trip mismatch");
	} finally {
		decrypted.fill(0);
	}
	console.log(JSON.stringify({ check: "kms-envelope-roundtrip", passed: true }));
} finally {
	original.fill(0);
	await client.close();
}
