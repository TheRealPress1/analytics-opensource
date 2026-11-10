import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { eventSpecsSchema } from "@subkit/core";
import { connectDatabase, PostgresRepository } from "@subkit/db";
import { z } from "zod";

const [configFile, outputFile] = process.argv.slice(2);
if (!configFile || !outputFile)
	throw new Error("Usage: pnpm app:create app-config.json /secure/path/app-key.json");
const input = z
	.object({
		name: z.string().min(1).max(80),
		slug: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
		eventSpecs: eventSpecsSchema,
		allowedOrigins: z.array(z.url()).default([]),
	})
	.strict()
	.parse(JSON.parse(await readFile(configFile, "utf8")));
const secretKey = `sk_${randomBytes(32).toString("base64url")}`;
// Reserve the destination before creating a database row. Never print the credential.
await writeFile(outputFile, "", { mode: 0o600, flag: "wx" });
const db = await connectDatabase();
try {
	const app = await new PostgresRepository(db.pool).createApp(input, secretKey);
	await writeFile(
		outputFile,
		JSON.stringify({ appId: app?.id, slug: input.slug, secretKey }, null, 2),
		{ mode: 0o600 },
	);
	console.log("App created; server key written to the specified private file.");
} finally {
	await db.close();
}
