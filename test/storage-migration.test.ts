import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { BACKUP_MAGIC, createSecretCodec } from "../src/main/secret-codec.ts";
import { createStore } from "../src/main/store.ts";

const passthroughCodec = createSecretCodec({
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`wrapped:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^wrapped:/, "")
});

test("migrations create a verified backup, model pricing storage, and remove obsolete feature tables", () => {
  const fixture = createLegacyFixture();
  let writerOpen = true;
  try {
    const store = createStore({
      secretCodec: passthroughCodec,
      dataDir: fixture.directory,
      dbPath: fixture.database
    });
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 9);
    assert.equal(store.db.prepare("PRAGMA table_info(request_logs)").all().some((column) => column.name === "attempt_chain_json"), true);
    const compactColumn = store.db.prepare("PRAGMA table_info(upstreams)").all()
      .find((column) => column.name === "compact_adapt_enabled");
    assert.equal(compactColumn?.dflt_value, "1");
    assert.equal(store.db.prepare("SELECT compact_adapt_enabled FROM upstreams").get().compact_adapt_enabled, 1);
    assert.deepEqual(
      { ...store.db.prepare("SELECT id, kind, base_url, supports_websocket FROM upstreams").get() },
      {
        id: "builtin-chatgpt-subscription-pool",
        kind: "chatgpt_subscription_pool",
        base_url: "https://legacy.example/codex",
        supports_websocket: 1
      }
    );
    assert.equal(store.db.prepare("PRAGMA table_info(upstream_models)").all().some((column) => column.name === "pricing_json"), true);
    assert.equal(
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_request_logs_upstream_created'").get()?.name,
      "idx_request_logs_upstream_created"
    );
    assert.equal(store.getSettings().gateway_websocket_max_connections, "64");
    assert.equal(store.getSettings().appearance_font_family, "system");
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_mappings'").get(), undefined);
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'routing_policies'").get(), undefined);
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'codex_sessions'").get(), undefined);
    assert.equal(store.getSettings().appearance_theme, "system");
    store.db.close();

    const backups = backupFiles(fixture.directory);
    assert.equal(backups.length, 1);
    const encryptedBytes = fs.readFileSync(backups[0]);
    assert.deepEqual(encryptedBytes.subarray(0, BACKUP_MAGIC.length), BACKUP_MAGIC);
    assert.equal(encryptedBytes.includes(Buffer.from("legacy-secret-token", "utf8")), false);
    const decrypted = decryptBackup(backups[0], fixture.directory);
    const backup = new DatabaseSync(decrypted, { readOnly: true });
    assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(backup.prepare("SELECT value FROM settings WHERE key = 'wal_fixture'").get().value, "committed");
    assert.equal(backup.prepare("PRAGMA user_version").get().user_version, 0);
    backup.close();
    fs.rmSync(decrypted, { force: true });
    fixture.writer.close();
    writerOpen = false;

    const restarted = createStore({
      secretCodec: passthroughCodec,
      dataDir: fixture.directory,
      dbPath: fixture.database
    });
    restarted.db.close();
    assert.equal(backupFiles(fixture.directory).length, 1);
  } finally {
    if (writerOpen) fixture.writer.close();
    cleanupFixture(fixture.directory);
  }
});

test("current migration upgrades an existing v1 database with its own verified backup", () => {
  const fixture = createV1Fixture();
  try {
    const store = createStore({ secretCodec: passthroughCodec, dataDir: fixture.directory, dbPath: fixture.database });
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 9);
    assert.equal(store.db.prepare("PRAGMA table_info(request_logs)").all().some((column) => column.name === "attempt_chain_json"), true);
    store.db.close();
    const backups = backupFiles(fixture.directory);
    assert.equal(backups.length, 1);
    const decrypted = decryptBackup(backups[0], fixture.directory);
    const backup = new DatabaseSync(decrypted, { readOnly: true });
    assert.equal(backup.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(backup.prepare("PRAGMA table_info(request_logs)").all().some((column) => column.name === "attempt_chain_json"), false);
    backup.close();
    fs.rmSync(decrypted, { force: true });
  } finally {
    cleanupFixture(fixture.directory);
  }
});

test("v8 migration preserves historical costs, rolls back failures and stores tier snapshots", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-service-tier-"));
  const database = path.join(directory, "codex-gateway.sqlite");
  const options = { secretCodec: passthroughCodec, dataDir: directory, dbPath: database };
  try {
    const original = createStore(options);
    original.addTokenLog({ method: "POST", estimated_cost: 12.5, cost_unit: "USD" });
    for (const column of ["requested_service_tier", "service_tier", "service_tier_source", "service_tier_multiplier"]) {
      original.db.exec(`ALTER TABLE request_logs DROP COLUMN ${column}`);
    }
    original.db.exec("DELETE FROM schema_migrations WHERE version >= 8; PRAGMA user_version = 7");
    original.db.exec("DELETE FROM settings WHERE key LIKE 'billing_service_tier_%'");
    original.db.close();
    assert.throws(() => createStore({ ...options, migrationHooks: { beforeMigrationCommit: ({ version }) => { if (version === 8) throw new Error("rollback-v8"); } } }), /rollback-v8/);
    const failed = new DatabaseSync(database);
    assert.equal(failed.prepare("PRAGMA user_version").get().user_version, 7);
    assert.equal(failed.prepare("PRAGMA table_info(request_logs)").all().some((row) => row.name === "service_tier"), false);
    failed.close();
    const upgraded = createStore(options);
    const historical = upgraded.listTokenLogs().items[0];
    assert.equal(historical.estimated_cost, 12.5);
    assert.equal(historical.service_tier, null);
    assert.equal(historical.service_tier_multiplier, null);
    assert.equal(upgraded.getSettings().billing_service_tier_standard_multiplier, "1");
    assert.equal(upgraded.getSettings().billing_service_tier_fast_multiplier, "2");
    assert.equal(upgraded.getSettings().billing_service_tier_ultrafast_multiplier, "6");
    assert.equal(upgraded.getSettings().billing_service_tier_pool_fast_multiplier, "2.5");
    assert.equal(upgraded.getSettings().billing_service_tier_pool_ultrafast_multiplier, "8");
    upgraded.addTokenLog({ method: "POST", requested_service_tier: "priority", service_tier: "fast", service_tier_source: "response", service_tier_multiplier: 2, estimated_cost: 5 });
    upgraded.saveSettings({ billing_service_tier_fast_multiplier: "3" });
    upgraded.db.close();
    const restarted = createStore(options);
    try {
      assert.equal(restarted.getSettings().billing_service_tier_fast_multiplier, "3");
      const current = restarted.listTokenLogs().items.find((row) => row.requested_service_tier === "priority");
      assert.equal(current.service_tier, "fast");
      assert.equal(current.service_tier_source, "response");
      assert.equal(current.service_tier_multiplier, 2);
      assert.equal(current.estimated_cost, 5);
      assert.equal(restarted.tokenSummary().total.estimated_cost, 17.5);
    } finally { restarted.db.close(); }
  } finally { cleanupFixture(directory); }
});

test("migration backups are automatically removed after one day", () => {
  const fixture = createLegacyFixture();
  try {
    const migrated = createStore({ secretCodec: passthroughCodec, dataDir: fixture.directory, dbPath: fixture.database });
    migrated.db.close();
    fixture.writer.close();
    const [backup] = backupFiles(fixture.directory);
    assert.ok(backup);
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(backup, expired, expired);

    const restarted = createStore({ secretCodec: passthroughCodec, dataDir: fixture.directory, dbPath: fixture.database });
    restarted.db.close();
    assert.deepEqual(backupFiles(fixture.directory), []);
  } finally {
    cleanupFixture(fixture.directory);
  }
});

test("existing plaintext migration backups are encrypted and removed on startup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-legacy-backup-"));
  const database = path.join(directory, "codex-gateway.sqlite");
  const initial = createStore({ secretCodec: passthroughCodec, dataDir: directory, dbPath: database });
  initial.db.close();
  const backupDirectory = path.join(directory, "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const plaintext = path.join(backupDirectory, "codex-gateway-schema-v1-legacy.sqlite");
  fs.copyFileSync(database, plaintext);
  try {
    const restarted = createStore({ secretCodec: passthroughCodec, dataDir: directory, dbPath: database });
    restarted.db.close();
    assert.equal(fs.existsSync(plaintext), false);
    assert.equal(fs.existsSync(`${plaintext}.enc`), true);
    assert.equal(passthroughCodec.isEncryptedFile(`${plaintext}.enc`), true);
  } finally {
    cleanupFixture(directory);
  }
});

test("startup atomically replaces an interrupted legacy backup encryption", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-interrupted-backup-"));
  const database = path.join(directory, "codex-gateway.sqlite");
  const initial = createStore({ secretCodec: passthroughCodec, dataDir: directory, dbPath: database });
  initial.db.close();
  const backupDirectory = path.join(directory, "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const plaintext = path.join(backupDirectory, "codex-gateway-schema-v1-interrupted.sqlite");
  const encrypted = `${plaintext}.enc`;
  fs.copyFileSync(database, plaintext);
  fs.writeFileSync(encrypted, "partial encrypted output", "utf8");
  try {
    const restarted = createStore({ secretCodec: passthroughCodec, dataDir: directory, dbPath: database });
    restarted.db.close();
    assert.equal(fs.existsSync(plaintext), false);
    assert.equal(passthroughCodec.isEncryptedFile(encrypted), true);
    const decrypted = decryptBackup(encrypted, directory);
    const backup = new DatabaseSync(decrypted, { readOnly: true });
    assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    backup.close();
  } finally {
    cleanupFixture(directory);
  }
});

test("v2 migration rolls back its column and version when interrupted", () => {
  const fixture = createV1Fixture();
  try {
    assert.throws(() => createStore({
      secretCodec: passthroughCodec,
      dataDir: fixture.directory,
      dbPath: fixture.database,
      migrationHooks: {
        beforeMigrationCommit({ version }) {
          if (version === 2) throw new Error("simulated v2 interruption");
        }
      }
    }), /simulated v2 interruption/);
    const database = new DatabaseSync(fixture.database);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(database.prepare("PRAGMA table_info(request_logs)").all().some((column) => column.name === "attempt_chain_json"), false);
    database.close();
    assert.equal(backupFiles(fixture.directory).length, 1);
  } finally {
    cleanupFixture(fixture.directory);
  }
});

test("v1 migration rolls back schema and version when interrupted", () => {
  const fixture = createLegacyFixture();
  try {
    assert.throws(() => createStore({
      secretCodec: passthroughCodec,
      dataDir: fixture.directory,
      dbPath: fixture.database,
      migrationHooks: {
        beforeMigrationCommit() {
          throw new Error("simulated migration interruption");
        }
      }
    }), /simulated migration interruption/);

    const database = new DatabaseSync(fixture.database);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'upstreams'").get(),
      undefined
    );
    database.close();
    assert.equal(backupFiles(fixture.directory).length, 1);
  } finally {
    fixture.writer.close();
    cleanupFixture(fixture.directory);
  }
});

test("v1 migration refuses a corrupted backup before changing the source database", () => {
  const fixture = createLegacyFixture();
  try {
    assert.throws(() => createStore({
      secretCodec: passthroughCodec,
      dataDir: fixture.directory,
      dbPath: fixture.database,
      migrationHooks: {
        afterBackup({ file }) {
          fs.writeFileSync(file, "corrupted backup", "utf8");
        }
      }
    }));

    const database = new DatabaseSync(fixture.database);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'upstreams'").get(),
      undefined
    );
    database.close();
  } finally {
    fixture.writer.close();
    cleanupFixture(fixture.directory);
  }
});

test("quota normalization defaults backfill old databases and preserve saved values after reopening", () => {
  const fixture = createLegacyFixture();
  let store;
  try {
    store = createStore({ secretCodec: passthroughCodec, dataDir: fixture.directory, dbPath: fixture.database });
    const settings = store.getSettings();
    assert.equal(settings.gpt_quota_normalization_enabled, undefined);
    assert.equal(settings.gpt_quota_multiplier_plus, "1");
    assert.equal(settings.gpt_quota_multiplier_prolite, "10");
    assert.equal(settings.gpt_quota_multiplier_pro, "20");
    assert.equal(settings.gpt_quota_multiplier_promax, "50");
    assert.equal(settings.gpt_quota_multiplier_free, "0");
    assert.equal(settings.gpt_quota_multiplier_go, "0");
    store.saveSettings({ gpt_quota_normalization_enabled: "true", gpt_quota_multiplier_pro: "12.5", gpt_quota_multiplier_go: "0.2" });
    store.db.close();
    store = createStore({ secretCodec: passthroughCodec, dataDir: fixture.directory, dbPath: fixture.database });
    assert.equal(store.getSettings().gpt_quota_normalization_enabled, "true");
    assert.equal(store.getSettings().gpt_quota_multiplier_pro, "12.5");
    assert.equal(store.getSettings().gpt_quota_multiplier_go, "0.2");
  } finally { store?.db.close(); fixture.writer.close(); cleanupFixture(fixture.directory); }
});

function createLegacyFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-v1-migration-"));
  const database = path.join(directory, "codex-gateway.sqlite");
  const writer = new DatabaseSync(database);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO settings (key, value) VALUES
      ('upstream_base_url', 'https://legacy.example/codex'),
      ('wal_fixture', 'committed');
    INSERT INTO accounts (id, name, access_token, refresh_token, created_at, updated_at)
    VALUES ('legacy-account', 'Legacy', 'legacy-secret-token', 'legacy-refresh-token', 1, 1);
  `);
  return { directory, database, writer };
}

function createV1Fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-v1-schema-"));
  const database = path.join(directory, "codex-gateway.sqlite");
  const store = createStore({ secretCodec: passthroughCodec, dataDir: directory, dbPath: database });
  store.db.exec("ALTER TABLE request_logs DROP COLUMN attempt_chain_json");
  store.db.exec("DELETE FROM schema_migrations WHERE version >= 2; PRAGMA user_version = 1");
  store.db.close();
  return { directory, database };
}

function backupFiles(directory) {
  const backupDirectory = path.join(directory, "backups");
  if (!fs.existsSync(backupDirectory)) return [];
  return fs.readdirSync(backupDirectory)
    .filter((file) => file.endsWith(".sqlite.enc"))
    .map((file) => path.join(backupDirectory, file));
}

function decryptBackup(file, directory) {
  const decrypted = path.join(directory, `decrypted-${Date.now()}-${Math.random()}.sqlite`);
  passthroughCodec.decryptFile(file, decrypted);
  return decrypted;
}

function cleanupFixture(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  } catch (error) {
    // node:sqlite can retain an empty Windows test directory until process teardown.
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
}

// 仅使用临时数据库模拟 v8 升级，确保下线功能的清理可回滚且不触碰业务记录。
test("v9 removes task tables after backup and rolls back failed cleanup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-retired-tasks-"));
  const database = path.join(directory, "codex-gateway.sqlite");
  const options = { secretCodec: passthroughCodec, dataDir: directory, dbPath: database };
  try {
    const original = createStore(options);
    original.saveAccount({ id: "preserved-account", name: "保留账号", access_token: "preserved-token" });
    original.addTokenLog({ method: "POST", estimated_cost: 12.5 });
    original.saveSettings({ show_session_wakeups_menu: "true", show_scheduled_tasks_menu: "true", billing_currency: "USD" });
    original.db.exec("CREATE TABLE session_wakeups (id TEXT PRIMARY KEY, session_id TEXT UNIQUE, data_json TEXT); CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, data_json TEXT)");
    original.db.prepare("INSERT INTO session_wakeups VALUES (?, ?, ?)").run("w", "session", '{"enabled":true}');
    original.db.prepare("INSERT INTO scheduled_tasks VALUES (?, ?)").run("t", '{"enabled":true}');
    original.db.exec("DELETE FROM schema_migrations WHERE version = 9; PRAGMA user_version = 8");
    original.db.close();
    assert.throws(() => createStore({ ...options, migrationHooks: { beforeMigrationCommit: ({ version }) => { if (version === 9) throw new Error("rollback-v9"); } } }), /rollback-v9/);
    const failed = new DatabaseSync(database);
    assert.equal(failed.prepare("PRAGMA user_version").get().user_version, 8);
    assert.equal(failed.prepare("SELECT COUNT(*) AS count FROM session_wakeups").get().count, 1);
    assert.equal(failed.prepare("SELECT COUNT(*) AS count FROM scheduled_tasks").get().count, 1);
    assert.equal(failed.prepare("SELECT value FROM settings WHERE key = 'show_scheduled_tasks_menu'").get().value, "true");
    failed.close();
    const upgraded = createStore(options);
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get().user_version, 9);
    assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('session_wakeups','scheduled_tasks')").get().count, 0);
    assert.equal(upgraded.getSettings().show_session_wakeups_menu, undefined);
    assert.equal(upgraded.getSettings().show_scheduled_tasks_menu, undefined);
    assert.equal(upgraded.getSettings().billing_currency, "USD");
    assert.equal(upgraded.listAccounts()[0].access_token, "preserved-token");
    assert.equal(upgraded.listTokenLogs().items[0].estimated_cost, 12.5);
    upgraded.db.close();
    const backupFile = backupFiles(directory).find(file => file.includes("schema-v8-"));
    assert.ok(backupFile);
    const restoredPath = decryptBackup(backupFile, directory);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM scheduled_tasks").get().count, 1);
    restored.close();
    const restarted = createStore(options);
    assert.equal(restarted.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('session_wakeups','scheduled_tasks')").get().count, 0);
    restarted.db.close();
  } finally { cleanupFixture(directory); }
});
