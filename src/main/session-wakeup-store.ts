import type { DatabaseSync } from "node:sqlite";
import type { SessionWakeup } from "../shared/contracts/session-wakeup.ts";

export const createSessionWakeupStore = (db: DatabaseSync) => ({
  list: (): SessionWakeup[] => db.prepare("SELECT data_json FROM session_wakeups ORDER BY rowid DESC").all()
    .map((row) => JSON.parse(String(row.data_json)) as SessionWakeup),
  put: (record: SessionWakeup): void => {
    db.prepare(`INSERT INTO session_wakeups (id, session_id, data_json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, data_json = excluded.data_json`)
      .run(record.id, record.sessionId, JSON.stringify(record));
  },
  delete: (id: string): void => { db.prepare("DELETE FROM session_wakeups WHERE id = ?").run(id); }
});
