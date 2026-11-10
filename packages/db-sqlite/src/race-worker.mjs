import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { SQLiteRepository } from "../dist/index.js";

const db = new Database(workerData.path, { timeout: 0 });
const repo = new SQLiteRepository(db);
const operation = () =>
	workerData.action === "delete"
		? repo.deleteSubject(workerData.appId, workerData.subject)
		: repo.ingest(workerData.appId, workerData.subject, "development", [workerData.event]);
try {
	try {
		await operation();
		throw new Error("Expected contention with the other connection");
	} catch (error) {
		if (error.code !== "SQLITE_BUSY") throw error;
		parentPort.postMessage({ kind: "blocked" });
	}
	await new Promise((resolve) => parentPort.once("message", resolve));
	try {
		parentPort.postMessage({ kind: "result", value: await operation() });
	} catch (error) {
		parentPort.postMessage({ kind: "result", error: error.constructor.name });
	}
} finally {
	db.close();
}
