import type { DatabaseSync } from "node:sqlite";
import type { ScheduledTask } from "../shared/contracts/scheduled-tasks.ts";

export const createScheduledTaskStore = (db: DatabaseSync) => ({
  list: (): ScheduledTask[] => db.prepare("SELECT data_json FROM scheduled_tasks ORDER BY rowid DESC").all()
    .map((row) => JSON.parse(String(row.data_json)) as ScheduledTask),
  put: (record: ScheduledTask): void => {
    db.prepare(`INSERT INTO scheduled_tasks (id, data_json) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json`).run(record.id, JSON.stringify(record));
  },
  delete: (id: string): void => { db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id); }
});
