import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { addTokenLog } from "./request-log-storage.ts";

const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 2000");
db.exec("PRAGMA foreign_keys = ON");
parentPort!.on("message", ({ entries }: { entries: Record<string, unknown>[] }) => {
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) addTokenLog(db, entry);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    parentPort!.postMessage({ ok: true });
  } catch {
    // Do not send SQL parameters or credentials back in diagnostics.
    parentPort!.postMessage({ ok: false });
  }
});
