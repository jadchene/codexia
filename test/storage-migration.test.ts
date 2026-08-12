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
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 4);
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
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 4);
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
  store.db.exec("DELETE FROM schema_migrations WHERE version = 2; PRAGMA user_version = 1");
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
