/** Disposable local PostgreSQL 16 acceptance test. Never point this at production. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dbRequire = createRequire(`${root}/packages/db/package.json`);
const workerRequire = createRequire(`${root}/apps/worker/package.json`);
const { Pool } = dbRequire("pg");
const { PgBoss } = await import(workerRequire.resolve("pg-boss"));
const { PostgresRepository, hashKey } = await import(`${root}/packages/db/dist/index.js`);
const { migrate } = await import(`${root}/packages/db/dist/migrate.js`);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone operator test is not a cached Turborepo task.
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
if (!adminUrl)
	throw new Error("TEST_ADMIN_DATABASE_URL is required for this disposable local test");
const parsed = new URL(adminUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
	throw new Error("Only a local test database is allowed");
const suffix = randomBytes(5).toString("hex");
const rolePassword = `test-only-${randomBytes(24).toString("hex")}`;
const dbName = `analytics_roles_${suffix}`;
const roles = {
	api: `analytics_api_${suffix}`,
	worker: `analytics_worker_${suffix}`,
	migrate: `analytics_migrate_${suffix}`,
};
const admin = new Pool({ connectionString: adminUrl });
const connections = [];
const createdRoles = [];
let databaseCreated = false;
let boss;
const checks = [];
function urlFor(user) {
	const url = new URL(adminUrl);
	url.pathname = `/${dbName}`;
	if (user) {
		url.username = user;
		url.password = rolePassword;
	}
	return url.toString();
}
function pool(user) {
	const value = new Pool({ connectionString: urlFor(user) });
	connections.push(value);
	return value;
}
function script(name, user) {
	const connection = new URL(urlFor(user));
	const password = decodeURIComponent(connection.password);
	connection.password = "";
	const result = spawnSync(
		"psql",
		[
			connection.toString(),
			"-X",
			"-v",
			"ON_ERROR_STOP=1",
			"-v",
			`db_name=${dbName}`,
			"-v",
			`api_user=${roles.api}`,
			"-v",
			`worker_user=${roles.worker}`,
			"-v",
			`migrate_user=${roles.migrate}`,
			"-f",
			`${root}/infra/gcp/${name}`,
		],
		{ encoding: "utf8", env: { ...process.env, PGPASSWORD: password } },
	);
	if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr}`);
}
async function denied(connection, sql) {
	let code;
	try {
		await connection.query(sql);
	} catch (error) {
		code = error.code;
	}
	assert.equal(code, "42501", `Expected permission denied: ${sql}`);
}
try {
	const version = (await admin.query("SHOW server_version_num")).rows[0].server_version_num;
	assert.ok(Number(version) >= 160000 && Number(version) < 170000, "PostgreSQL 16 required");
	for (const role of Object.values(roles)) {
		await admin.query(
			`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${rolePassword}'`,
		);
		createdRoles.push(role);
	}
	await admin.query(`CREATE DATABASE "${dbName}"`);
	databaseCreated = true;
	script("bootstrap-grants.sql");
	const migrator = pool(roles.migrate);
	const api = pool(roles.api);
	const worker = pool(roles.worker);
	await migrate(migrator);
	await migrate(migrator);
	checks.push("migration identity creates and replays migrations");
	script("runtime-grants.sql", roles.migrate);
	const appId = randomUUID();
	const appKey = `sk_${randomBytes(24).toString("hex")}`;
	await migrator.query(
		"INSERT INTO apps(id,name,slug,secret_key_hash,event_specs) VALUES($1,$2,$3,$4,$5)",
		[
			appId,
			"Synthetic grant test",
			`fixture-${suffix}`,
			hashKey(appKey),
			JSON.stringify({ app_opened: {} }),
		],
	);
	const repository = new PostgresRepository(api);
	assert.equal((await repository.appByKey(appKey)).id, appId);
	assert.equal(await repository.consumeRate("fixture", 10, new Date()), true);
	assert.equal(await repository.consumeRate("fixture", 10, new Date()), true);
	const event = {
		id: randomUUID(),
		name: "app_opened",
		occurredAt: new Date().toISOString(),
		sessionId: randomUUID(),
		properties: {},
	};
	assert.deepEqual(await repository.ingest(appId, "opaque_fixture", "development", [event]), {
		accepted: 1,
		duplicates: 0,
	});
	assert.deepEqual(await repository.ingest(appId, "opaque_fixture", "development", [event]), {
		accepted: 0,
		duplicates: 1,
	});
	assert.equal((await repository.history(appId, "development")).length, 1);
	assert.equal(await repository.deleteSubject(appId, "opaque_fixture"), 1);
	assert.equal(await repository.isSubjectDeleted(appId, "opaque_fixture"), true);
	await assert.rejects(repository.ingest(appId, "opaque_fixture", "development", [event]));
	await denied(api, "CREATE TABLE public.forbidden(id integer)");
	await denied(api, "DELETE FROM apps");
	await denied(api, "SELECT * FROM schema_migrations");
	checks.push(
		"API ingest, retry, rate limit, analytics and deletion work without DDL or app administration",
	);
	boss = new PgBoss({
		createSchema: false,
		db: { executeSql: async (text, values) => ({ rows: (await worker.query(text, values)).rows }) },
	});
	boss.on("error", () => {});
	await boss.start();
	await boss.createQueue("usage-housekeeping");
	await boss.schedule("usage-housekeeping", "*/15 * * * *", {});
	await worker.query(
		"INSERT INTO worker_heartbeats(id,updated_at) VALUES('usage',now()) ON CONFLICT(id) DO UPDATE SET updated_at=now()",
	);
	await worker.query(
		"INSERT INTO worker_heartbeats(id,updated_at) VALUES('usage',now()) ON CONFLICT(id) DO UPDATE SET updated_at=now()",
	);
	await worker.query("DELETE FROM rate_limits WHERE window_start < $1", [
		Math.floor(Date.now() / 60000) - 60,
	]);
	await worker.query("SELECT 1 FROM pgboss.job LIMIT 1");
	await denied(worker, "SELECT * FROM apps");
	await denied(worker, "SELECT * FROM events");
	await denied(worker, "CREATE TABLE public.forbidden(id integer)");
	checks.push(
		"Worker owns queue schema and can maintain rate limits/heartbeat without app data access",
	);
	console.log(JSON.stringify({ passed: true, checks, postgresMajor: 16 }));
} finally {
	if (boss) await boss.stop({ timeout: 5000 });
	await Promise.all(connections.map((connection) => connection.end()));
	if (databaseCreated) await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
	for (const role of createdRoles) await admin.query(`DROP ROLE "${role}"`);
	await admin.end();
}
