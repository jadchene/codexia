import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { dbPath, dataDir } from "./paths.ts";
import type { SecretCodec } from "./secret-codec";
import type { Settings } from "../shared/contracts/settings";
import type { AppLogPage, LogQuery, RequestLogPage, TokenSummary } from "../shared/contracts/logs";

type Db = any;
type Row = Record<string, any>;

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const LATEST_SCHEMA_VERSION = 4;
const MIGRATION_BACKUP_RETENTION_MS = 24 * 60 * 60 * 1000;
const MIGRATION_BACKUP_FILE_PATTERN = /^codex-gateway-schema-v\d+-.*\.sqlite$/;

interface MigrationHooks {
  beforeMigrationCommit?: (context: { db: Db; version: number }) => void;
  afterBackup?: (context: { file: string; version: number }) => void;
}
interface StoreOptions {
  secretCodec?: SecretCodec;
  dataDir?: string;
  dbPath?: string;
  migrationHooks?: MigrationHooks;
}
export interface Store {
  db: Db;
  paths: { dataDir: string; dbPath: string };
  getSettings: () => Settings;
  saveSettings: (patch: Record<string, unknown>) => Settings;
  listAccounts: () => Row[];
  saveAccount: (input: Row) => Row;
  setAccountEnabled: (id: string, enabled: boolean) => unknown;
  deleteAccount: (id: string) => unknown;
  updateUsage: (id: string, usage: Row) => void;
  saveLoginSession: (session: Row) => void;
  getLoginSession: (id: string) => Row | null;
  updateLoginSession: (id: string, status: string, error: string | null) => void;
  listTokenLogs: (query?: Partial<LogQuery>) => RequestLogPage;
  addTokenLog: (entry: Row) => void;
  clearTokenLogs: () => { deleted: number };
  tokenSummary: (query?: Partial<LogQuery>) => TokenSummary;
  getLastRefreshAllUsageAt: () => number;
  listAppLogs: (query?: Partial<LogQuery>) => AppLogPage;
  addAppLog: (entry: Row) => void;
  clearAppLogs: () => { deleted: number };
  runMaintenance: () => { requestLogsDeleted: number; appLogsDeleted: number; loginSessionsDeleted: number };
  compactDatabase: () => unknown;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function createStore(options: StoreOptions = {}): Store {
  const secretCodec = options.secretCodec;
  if (!secretCodec) throw new Error("createStore requires a secret codec.");
  const targetDataDir = options.dataDir || dataDir();
  const targetDbPath = options.dbPath || dbPath();
  fs.mkdirSync(targetDataDir, { recursive: true });
  removeExpiredMigrationBackups(targetDataDir);
  const existingDatabase = fs.existsSync(targetDbPath) && fs.statSync(targetDbPath).size > 0;
  const db = new DatabaseSync(targetDbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    if (existingDatabase && schemaVersion(db) < LATEST_SCHEMA_VERSION) {
      createMigrationBackup(db, targetDataDir, options.migrationHooks);
    }
    migrate(db);
    migrateV1(db, options.migrationHooks);
    migrateV2(db, options.migrationHooks);
    migrateV3(db, options.migrationHooks);
    migrateV4(db, options.migrationHooks);
    migrateSecrets(db, secretCodec);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    db,
    paths: { dataDir: targetDataDir, dbPath: targetDbPath },
    getSettings: () => getSettings(db),
    saveSettings: (patch) => saveSettings(db, patch),
    listAccounts: () => listAccounts(db, secretCodec),
    saveAccount: (input) => saveAccount(db, input, secretCodec),
    setAccountEnabled: (id, enabled) => setAccountEnabled(db, id, enabled),
    deleteAccount: (id) => db.prepare("DELETE FROM accounts WHERE id = ?").run(id),
    updateUsage: (id, usage) => updateUsage(db, id, usage),
    saveLoginSession: (session) => saveLoginSession(db, session, secretCodec),
    getLoginSession: (id) => getLoginSession(db, id, secretCodec),
    updateLoginSession: (id, status, error) => updateLoginSession(db, id, status, error),
    listTokenLogs: (query) => listTokenLogs(db, query),
    addTokenLog: (entry) => addTokenLog(db, entry),
    clearTokenLogs: () => clearTokenLogs(db),
    tokenSummary: (query) => tokenSummary(db, query),
    getLastRefreshAllUsageAt: () => getLastRefreshAllUsageAt(db),
    listAppLogs: (query) => listAppLogs(db, query),
    addAppLog: (entry) => addAppLog(db, entry),
    clearAppLogs: () => clearAppLogs(db),
    runMaintenance: () => runMaintenance(db, targetDataDir),
    compactDatabase: () => compactDatabase(db)
  };
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      id_token TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      last_refresh TEXT,
      account_id TEXT,
      workspace_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      subscription_plan TEXT,
      subscription_expires_at INTEGER,
      quota_5h_used_percent REAL NOT NULL DEFAULT 0,
      quota_5h_reset_at INTEGER,
      quota_7d_used_percent REAL NOT NULL DEFAULT 0,
      quota_7d_reset_at INTEGER,
      reset_credits_available_count INTEGER NOT NULL DEFAULT 0,
      reset_credits_next_expires_at INTEGER,
      reset_credits_json TEXT,
      raw_usage_json TEXT,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT,
      method TEXT NOT NULL,
      request_path TEXT,
      upstream_path TEXT,
      session_id TEXT,
      version TEXT,
      status INTEGER,
      duration_ms INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_sessions (
      id TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'info',
      scope TEXT,
      action TEXT,
      status TEXT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_request_logs_account_created ON request_logs(account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_app_logs_created_at ON app_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_login_sessions_updated_at ON login_sessions(updated_at);
  `);
  addColumnIfMissing(db, "accounts", "id_token", "TEXT");
  addColumnIfMissing(db, "accounts", "last_refresh", "TEXT");
  addColumnIfMissing(db, "request_logs", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "request_logs", "request_path", "TEXT");
  addColumnIfMissing(db, "request_logs", "upstream_path", "TEXT");
  addColumnIfMissing(db, "request_logs", "session_id", "TEXT");
  addColumnIfMissing(db, "request_logs", "version", "TEXT");
  dropColumnIfExists(db, "request_logs", "path");
  addColumnIfMissing(db, "request_logs", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "request_logs", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "request_logs", "reasoning_output_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "request_logs", "total_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "accounts", "reset_credits_available_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "accounts", "reset_credits_next_expires_at", "INTEGER");
  addColumnIfMissing(db, "accounts", "reset_credits_json", "TEXT");
  const defaults = {
    gateway_host: "localhost",
    gateway_port: "8436",
    gateway_api_key: randomGatewayApiKey(),
    upstream_base_url: "https://chatgpt.com/backend-api/codex",
    request_timeout_ms: "0",
    gateway_connect_timeout_ms: "30000",
    gateway_stream_idle_timeout_ms: "120000",
    gateway_unary_timeout_ms: "300000",
    gateway_shutdown_grace_ms: "2000",
    gateway_request_body_limit_bytes: "67108864",
    gateway_error_body_limit_bytes: "1048576",
    gateway_compaction_response_limit_bytes: "67108864",
    gateway_max_concurrent_requests: "16",
    gateway_websocket_max_connections: "128",
    gateway_websocket_max_payload_bytes: "134217728",
    gateway_websocket_buffer_high_water_bytes: "4194304",
    gateway_websocket_pending_queue_limit_bytes: "4194304",
    gateway_websocket_idle_timeout_ms: "120000",
    gateway_websocket_reject_http_only_model_upgrade: "true",
    gateway_quota_cooldown_ms: "60000",
    usage_refresh_interval_secs: "900",
    usage_refresh_timeout_ms: "20000",
    last_usage_refresh_all_at: "0",
    auto_start_gateway: "false",
    auto_start_mcp_gateway: "false",
    mcp_gateway_config_path: "",
    mcp_gateway_host: "127.0.0.1",
    mcp_gateway_port: "3000",
    mcp_gateway_path: "/mcp",
    startup_launch: "disabled",
    close_behavior: "exit",
    codex_quota_headers_mode: "block",
    codex_auth_mode: "gateway",
    codex_config_use_openai_base_url: "true",
    codex_selected_account_id: "",
    auto_review_upstream_model: "",
    gateway_current_account_id: "",
    gateway_last_daily_rebalance_date: "",
    gateway_affinity_state_json: "{}",
    ignore_five_hour_limit: "false",
    billing_currency: "USD",
    request_log_retention_days: "30",
    app_log_retention_days: "14"
  };
  const insert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);
  fillBlankSetting(db, "mcp_gateway_host", "127.0.0.1");
  fillBlankSetting(db, "mcp_gateway_port", "3000");
  fillBlankSetting(db, "mcp_gateway_path", "/mcp");
  repairLastRefreshAllUsageAt(db);
}

function migrateV1(db: Db, hooks: MigrationHooks = {}): void {
  if (schemaVersion(db) >= 1) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS upstreams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('chatgpt_subscription_pool', 'responses_api')),
        enabled INTEGER NOT NULL DEFAULT 1,
        base_url TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'bearer',
        api_key_encrypted TEXT,
        custom_headers_encrypted_json TEXT,
        model_discovery_mode TEXT NOT NULL DEFAULT 'openai_models',
        models_endpoint TEXT,
        supports_http INTEGER NOT NULL DEFAULT 1,
        supports_websocket INTEGER NOT NULL DEFAULT 0,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        cost_factors_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS upstream_models (
        upstream_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        available INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        raw_metadata_json TEXT NOT NULL DEFAULT '{}',
        last_seen_at INTEGER,
        last_synced_at INTEGER,
        PRIMARY KEY (upstream_id, model_id),
        FOREIGN KEY (upstream_id) REFERENCES upstreams(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_upstreams_enabled_kind ON upstreams(enabled, kind);
      CREATE INDEX IF NOT EXISTS idx_upstream_models_available ON upstream_models(upstream_id, available);
    `);

    addColumnIfMissing(db, "request_logs", "upstream_id", "TEXT");
    addColumnIfMissing(db, "request_logs", "upstream_name", "TEXT");
    addColumnIfMissing(db, "request_logs", "upstream_kind", "TEXT");
    addColumnIfMissing(db, "request_logs", "client_model", "TEXT");
    addColumnIfMissing(db, "request_logs", "upstream_model", "TEXT");
    addColumnIfMissing(db, "request_logs", "attempt_count", "INTEGER NOT NULL DEFAULT 1");
    addColumnIfMissing(db, "request_logs", "fallback_from", "TEXT");
    addColumnIfMissing(db, "request_logs", "fallback_reason", "TEXT");
    addColumnIfMissing(db, "request_logs", "credential_ref", "TEXT");
    addColumnIfMissing(db, "request_logs", "estimated_cost", "REAL");
    addColumnIfMissing(db, "request_logs", "cost_unit", "TEXT");

    const timestamp = now();
    const legacyBaseUrl = db.prepare("SELECT value FROM settings WHERE key = ?")
      .get("upstream_base_url")?.value || "https://chatgpt.com/backend-api/codex";
    db.prepare(`
      INSERT OR IGNORE INTO upstreams (
        id, name, kind, enabled, base_url, auth_type, model_discovery_mode,
        supports_http, supports_websocket, capabilities_json, cost_factors_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, 'bearer', 'disabled', 1, 1, ?, '{}', ?, ?)
    `).run(
      "builtin-chatgpt-subscription-pool",
      "ChatGPT 订阅账号池",
      "chatgpt_subscription_pool",
      legacyBaseUrl,
      JSON.stringify({ responses: true, compact: true, websocket: true }),
      timestamp,
      timestamp
    );
    insertDefaultSetting(db, "appearance_theme", "system");
    insertDefaultSetting(db, "appearance_density", "comfortable");
    insertDefaultSetting(db, "navigation_collapsed", "false");
    hooks.beforeMigrationCommit?.({ db, version: 1 });
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(1, timestamp);
    db.exec("PRAGMA user_version = 1");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateV2(db: Db, hooks: MigrationHooks = {}): void {
  if (schemaVersion(db) >= 2) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(db, "request_logs", "attempt_chain_json", "TEXT");
    hooks.beforeMigrationCommit?.({ db, version: 2 });
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(2, now());
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateV3(db: Db, hooks: MigrationHooks = {}): void {
  if (schemaVersion(db) >= 3) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(db, "upstream_models", "pricing_json", "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing(db, "upstreams", "balance_query_type", "TEXT NOT NULL DEFAULT 'none'");
    addColumnIfMissing(db, "upstreams", "balance_json", "TEXT");
    addColumnIfMissing(db, "upstreams", "balance_checked_at", "INTEGER");
    addColumnIfMissing(db, "upstreams", "balance_error", "TEXT");
    insertDefaultSetting(db, "billing_currency", "USD");
    db.prepare("DELETE FROM settings WHERE key IN ('billing_uncached_input_factor', 'billing_cached_input_factor', 'billing_output_factor')").run();
    db.exec(`
      DROP TABLE IF EXISTS routing_policy_targets;
      DROP TABLE IF EXISTS routing_policies;
      DROP TABLE IF EXISTS model_mappings;
      DROP TABLE IF EXISTS codex_sessions;
    `);
    hooks.beforeMigrationCommit?.({ db, version: 3 });
    db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(3, now());
    db.exec("PRAGMA user_version = 3");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateV4(db: Db, hooks: MigrationHooks = {}): void {
  if (schemaVersion(db) >= 4) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(db, "upstreams", "compact_adapt_enabled", "INTEGER NOT NULL DEFAULT 1");
    hooks.beforeMigrationCommit?.({ db, version: 4 });
    db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(4, now());
    db.exec("PRAGMA user_version = 4");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function schemaVersion(db: Db): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version || 0);
}

function createMigrationBackup(db: Db, targetDataDir: string, hooks: MigrationHooks = {}): string {
  const backupDir = path.join(targetDataDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const version = schemaVersion(db);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(backupDir, `codex-gateway-schema-v${version}-${timestamp}.sqlite`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  hooks.afterBackup?.({ file, version });
  validateMigrationBackup(file);
  return file;
}

function removeExpiredMigrationBackups(targetDataDir: string, currentTime = Date.now()): void {
  const backupDir = path.join(targetDataDir, "backups");
  if (!fs.existsSync(backupDir)) return;
  const expiresBefore = currentTime - MIGRATION_BACKUP_RETENTION_MS;
  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isFile() || !MIGRATION_BACKUP_FILE_PATTERN.test(entry.name)) continue;
    const file = path.join(backupDir, entry.name);
    if (fs.statSync(file).mtimeMs <= expiresBefore) fs.unlinkSync(file);
  }
}

function validateMigrationBackup(file: string): void {
  const backup = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").get()?.integrity_check;
    if (integrity !== "ok") throw new Error(`数据库迁移备份完整性校验失败：${integrity || "unknown"}`);
    for (const table of ["settings", "accounts"]) {
      const exists = backup.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!exists) throw new Error(`数据库迁移备份缺少必要表：${table}`);
      backup.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    }
    schemaVersion(backup);
  } finally {
    backup.close();
  }
}

function insertDefaultSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function randomGatewayApiKey(): string {
  return `sk-${randomBytes(24).toString("base64url")}`;
}

function migrateSecrets(db: Db, secretCodec: SecretCodec): void {
  const accountRows = db.prepare("SELECT id, id_token, access_token, refresh_token FROM accounts").all();
  const loginRows = db.prepare("SELECT id, code_verifier FROM login_sessions").all();
  const accountUpdate = db.prepare(`
    UPDATE accounts SET id_token = ?, access_token = ?, refresh_token = ? WHERE id = ?
  `);
  const loginUpdate = db.prepare("UPDATE login_sessions SET code_verifier = ? WHERE id = ?");
  let changed = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of accountRows) {
      const values = [row.id_token, row.access_token, row.refresh_token];
      if (!values.some((value) => value && !secretCodec.isEncrypted(value))) continue;
      accountUpdate.run(
        secretCodec.encrypt(row.id_token),
        secretCodec.encrypt(row.access_token),
        secretCodec.encrypt(row.refresh_token),
        row.id
      );
      changed = true;
    }
    for (const row of loginRows) {
      if (!row.code_verifier || secretCodec.isEncrypted(row.code_verifier)) continue;
      loginUpdate.run(secretCodec.encrypt(row.code_verifier), row.id);
      changed = true;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (changed) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  }
}

function getSettings(db: Db): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  return Object.fromEntries(rows.map((row: Row) => [row.key, row.value]));
}

function saveSettings(db: Db, patch: Record<string, unknown>): Settings {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(patch)) stmt.run(key, String(value ?? ""));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getSettings(db);
}

function listAccounts(db: Db, secretCodec: SecretCodec): Row[] {
  return db.prepare("SELECT * FROM accounts ORDER BY created_at ASC, id ASC").all()
    .map((row: Row) => decodeAccountSecrets(row, secretCodec));
}

function saveAccount(db: Db, input: Row, secretCodec: SecretCodec): Row {
  const ts = now();
  const id = input.id || randomUUID();
  db.prepare(`
    INSERT INTO accounts (
      id, name, email, id_token, access_token, refresh_token, last_refresh, account_id, workspace_id, status, enabled, priority,
      subscription_plan, subscription_expires_at, quota_5h_used_percent, quota_5h_reset_at,
      quota_7d_used_percent, quota_7d_reset_at, reset_credits_available_count, reset_credits_next_expires_at,
      reset_credits_json, raw_usage_json, note, created_at, updated_at
    ) VALUES (
      @id, @name, @email, @id_token, @access_token, @refresh_token, @last_refresh, @account_id, @workspace_id, @status, @enabled, @priority,
      @subscription_plan, @subscription_expires_at, @quota_5h_used_percent, @quota_5h_reset_at,
      @quota_7d_used_percent, @quota_7d_reset_at, @reset_credits_available_count, @reset_credits_next_expires_at,
      @reset_credits_json, @raw_usage_json, @note, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      id_token = excluded.id_token,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      last_refresh = excluded.last_refresh,
      account_id = excluded.account_id,
      workspace_id = excluded.workspace_id,
      status = excluded.status,
      enabled = excluded.enabled,
      priority = excluded.priority,
      subscription_plan = excluded.subscription_plan,
      subscription_expires_at = excluded.subscription_expires_at,
      quota_5h_used_percent = excluded.quota_5h_used_percent,
      quota_5h_reset_at = excluded.quota_5h_reset_at,
      quota_7d_used_percent = excluded.quota_7d_used_percent,
      quota_7d_reset_at = excluded.quota_7d_reset_at,
      reset_credits_available_count = excluded.reset_credits_available_count,
      reset_credits_next_expires_at = excluded.reset_credits_next_expires_at,
      reset_credits_json = excluded.reset_credits_json,
      raw_usage_json = excluded.raw_usage_json,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(encodeAccountSecrets(normalizeAccount({ ...input, id, created_at: input.created_at || ts, updated_at: ts }), secretCodec));
  return decodeAccountSecrets(db.prepare("SELECT * FROM accounts WHERE id = ?").get(id), secretCodec);
}

function normalizeAccount(input: Row): Row {
  return {
    id: input.id,
    name: String(input.name || input.email || "GPT Account").trim(),
    email: input.email || null,
    id_token: input.id_token || null,
    access_token: String(input.access_token || "").trim(),
    refresh_token: input.refresh_token || null,
    last_refresh: input.last_refresh || null,
    account_id: input.account_id || null,
    workspace_id: input.workspace_id || null,
    status: input.status || "active",
    enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
    priority: Number(input.priority || 100),
    subscription_plan: input.subscription_plan || null,
    subscription_expires_at: input.subscription_expires_at || null,
    quota_5h_used_percent: Number(input.quota_5h_used_percent || 0),
    quota_5h_reset_at: input.quota_5h_reset_at || null,
    quota_7d_used_percent: Number(input.quota_7d_used_percent || 0),
    quota_7d_reset_at: input.quota_7d_reset_at || null,
    reset_credits_available_count: Number(input.reset_credits_available_count || 0),
    reset_credits_next_expires_at: input.reset_credits_next_expires_at || null,
    reset_credits_json: input.reset_credits_json || null,
    raw_usage_json: input.raw_usage_json || null,
    note: input.note || null,
    created_at: input.created_at,
    updated_at: input.updated_at
  };
}

function encodeAccountSecrets(account: Row, secretCodec: SecretCodec): Row {
  return {
    ...account,
    id_token: secretCodec.encrypt(account.id_token),
    access_token: secretCodec.encrypt(account.access_token),
    refresh_token: secretCodec.encrypt(account.refresh_token)
  };
}

function decodeAccountSecrets(account: Row, secretCodec: SecretCodec): Row {
  if (!account) return account;
  return {
    ...account,
    id_token: secretCodec.decrypt(account.id_token),
    access_token: secretCodec.decrypt(account.access_token),
    refresh_token: secretCodec.decrypt(account.refresh_token),
    enabled: Boolean(account.enabled)
  };
}

function updateUsage(db: Db, id: string, usage: Row): void {
  const params = {
    quota_5h_used_percent: null,
    quota_5h_reset_at: null,
    quota_7d_used_percent: null,
    quota_7d_reset_at: null,
    reset_credits_available_count: null,
    reset_credits_next_expires_at: null,
    reset_credits_json: null,
    raw_usage_json: null,
    ...usage,
    id,
    updated_at: now()
  };
  db.prepare(`
    UPDATE accounts SET
      quota_5h_used_percent = COALESCE(@quota_5h_used_percent, quota_5h_used_percent),
      quota_5h_reset_at = COALESCE(@quota_5h_reset_at, quota_5h_reset_at),
      quota_7d_used_percent = COALESCE(@quota_7d_used_percent, quota_7d_used_percent),
      quota_7d_reset_at = COALESCE(@quota_7d_reset_at, quota_7d_reset_at),
      reset_credits_available_count = COALESCE(@reset_credits_available_count, reset_credits_available_count),
      reset_credits_next_expires_at = COALESCE(@reset_credits_next_expires_at, reset_credits_next_expires_at),
      reset_credits_json = COALESCE(@reset_credits_json, reset_credits_json),
      raw_usage_json = COALESCE(@raw_usage_json, raw_usage_json),
      updated_at = @updated_at
    WHERE id = @id
  `).run(params);
}

function setAccountEnabled(db: Db, id: string, enabled: boolean): unknown {
  db.prepare("UPDATE accounts SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, now(), id);
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
}

function addColumnIfMissing(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row: Row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function dropColumnIfExists(db: Db, table: string, column: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row: Row) => row.name);
  if (!columns.includes(column)) return;
  try {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  } catch {
    // Older SQLite builds may not support DROP COLUMN. The application no longer reads or writes this field.
  }
}

function fillBlankSetting(db: Db, key: string, value: string): void {
  db.prepare("UPDATE settings SET value = ? WHERE key = ? AND TRIM(value) = ''").run(value, key);
}

function saveLoginSession(db: Db, session: Row, secretCodec: SecretCodec): void {
  const ts = now();
  db.prepare(`
    INSERT INTO login_sessions (id, code_verifier, redirect_uri, status, error, created_at, updated_at)
    VALUES (@id, @code_verifier, @redirect_uri, @status, NULL, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      code_verifier = excluded.code_verifier,
      redirect_uri = excluded.redirect_uri,
      status = excluded.status,
      error = NULL,
      updated_at = excluded.updated_at
  `).run({ ...session, code_verifier: secretCodec.encrypt(session.code_verifier), created_at: ts, updated_at: ts });
}

function getLoginSession(db: Db, id: string, secretCodec: SecretCodec): Row | null {
  const session = db.prepare("SELECT * FROM login_sessions WHERE id = ?").get(id);
  return session ? { ...session, code_verifier: secretCodec.decrypt(session.code_verifier) } : null;
}

function updateLoginSession(db: Db, id: string, status: string, error: string | null): void {
  db.prepare(`
    UPDATE login_sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?
  `).run(status, error || null, now(), id);
}

function addTokenLog(db: Db, entry: Row): void {
  db.prepare(`
    INSERT INTO request_logs (
      account_id, method, request_path, upstream_path, session_id, version, status, duration_ms,
      input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      message, upstream_id, upstream_name, upstream_kind, client_model, upstream_model,
      attempt_count, attempt_chain_json, fallback_from, fallback_reason, credential_ref, estimated_cost, cost_unit,
      created_at
    )
    VALUES (
      @account_id, @method, @request_path, @upstream_path, @session_id, @version, @status, @duration_ms,
      @input_tokens, @cached_input_tokens, @output_tokens, @reasoning_output_tokens, @total_tokens,
      @message, @upstream_id, @upstream_name, @upstream_kind, @client_model, @upstream_model,
      @attempt_count, @attempt_chain_json, @fallback_from, @fallback_reason, @credential_ref, @estimated_cost, @cost_unit,
      @created_at
    )
  `).run({
    account_id: entry.account_id || null,
    method: entry.method || "GET",
    request_path: entry.request_path || null,
    upstream_path: entry.upstream_path || null,
    session_id: entry.session_id || null,
    version: entry.version || null,
    status: entry.status || null,
    duration_ms: entry.duration_ms || null,
    input_tokens: toInt(entry.input_tokens),
    cached_input_tokens: toInt(entry.cached_input_tokens),
    output_tokens: toInt(entry.output_tokens),
    reasoning_output_tokens: toInt(entry.reasoning_output_tokens),
    total_tokens: toInt(entry.total_tokens),
    message: entry.message || null,
    upstream_id: entry.upstream_id || null,
    upstream_name: entry.upstream_name || null,
    upstream_kind: entry.upstream_kind || null,
    client_model: entry.client_model || null,
    upstream_model: entry.upstream_model || null,
    attempt_count: Math.max(1, toInt(entry.attempt_count || 1)),
    attempt_chain_json: normalizeAttemptChainJson(entry.attempt_chain_json),
    fallback_from: entry.fallback_from || null,
    fallback_reason: entry.fallback_reason || null,
    credential_ref: entry.credential_ref || null,
    estimated_cost: Number.isFinite(Number(entry.estimated_cost)) ? Number(entry.estimated_cost) : null,
    cost_unit: entry.cost_unit || null,
    created_at: now()
  });
}

function clearTokenLogs(db: Db): { deleted: number } {
  const result = db.prepare("DELETE FROM request_logs").run();
  compactDatabase(db);
  return { deleted: Number(result.changes || 0) };
}

function listTokenLogs(db: Db, query: Partial<LogQuery> = {}): RequestLogPage {
  const range = normalizeLogQuery(query);
  const filter = tokenLogFilter(range);
  const items = db.prepare(`
    SELECT request_logs.*, accounts.name AS account_name, accounts.email AS account_email
    FROM request_logs
    LEFT JOIN accounts ON accounts.id = request_logs.account_id
    WHERE ${filter.where}
    ORDER BY request_logs.id DESC
    LIMIT ? OFFSET ?
  `).all(...filter.params, range.pageSize, range.offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM request_logs
    LEFT JOIN accounts ON accounts.id = request_logs.account_id
    WHERE ${filter.where}
  `).get(...filter.params).total;
  return {
    items,
    total,
    page: range.page,
    pageSize: range.pageSize,
    startAt: range.startAt,
    endAt: range.endAt,
    query: logQueryFromRange(range)
  };
}

function tokenSummary(db: Db, query: Partial<LogQuery> = {}): TokenSummary {
  const range = normalizeLogQuery(query);
  const filter = tokenLogFilter(range);
  const total = db.prepare(`
    SELECT
      COUNT(*) AS calls,
      COALESCE(SUM(CASE WHEN CAST(request_logs.status AS INTEGER) >= 400 THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(SUM(CASE WHEN request_logs.fallback_reason IS NOT NULL AND request_logs.fallback_reason <> '' THEN 1 ELSE 0 END), 0) AS fallback_count,
      COALESCE(AVG(request_logs.duration_ms), 0) AS average_duration_ms,
      COALESCE(SUM(request_logs.estimated_cost), 0) AS estimated_cost,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM request_logs
    LEFT JOIN accounts ON accounts.id = request_logs.account_id
    WHERE ${filter.where}
  `).get(...filter.params);
  const byAccount = db.prepare(`
    SELECT
      request_logs.account_id,
      CASE
        WHEN request_logs.account_id IS NOT NULL THEN COALESCE(accounts.name, request_logs.account_id)
        ELSE NULL
      END AS account_name,
      CASE WHEN request_logs.account_id IS NULL THEN request_logs.upstream_id ELSE NULL END AS upstream_id,
      CASE
        WHEN request_logs.account_id IS NULL THEN COALESCE(MAX(request_logs.upstream_name), request_logs.upstream_id, '未识别渠道')
        ELSE NULL
      END AS upstream_name,
      COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM request_logs
    LEFT JOIN accounts ON accounts.id = request_logs.account_id
    WHERE ${filter.where}
    GROUP BY
      request_logs.account_id,
      CASE WHEN request_logs.account_id IS NULL THEN request_logs.upstream_id ELSE NULL END
    ORDER BY total_tokens DESC
  `).all(...filter.params);
  return { total, byAccount };
}

function tokenLogFilter(range: ReturnType<typeof normalizeLogQuery>): { where: string; params: unknown[] } {
  const clauses = [
    "request_logs.created_at >= ?",
    "request_logs.created_at < ?"
  ];
  const params: unknown[] = [range.startAt, range.endAt];
  if (range.accountId) {
    clauses.push("request_logs.account_id = ?");
    params.push(range.accountId);
  }
  if (range.upstreamId) {
    clauses.push("request_logs.upstream_id = ?");
    params.push(range.upstreamId);
  }
  if (range.clientModel) {
    clauses.push("request_logs.client_model LIKE ?");
    params.push(`%${range.clientModel}%`);
  }
  if (range.upstreamModel) {
    clauses.push("request_logs.upstream_model LIKE ?");
    params.push(`%${range.upstreamModel}%`);
  }
  if (range.sessionId) {
    clauses.push("request_logs.session_id LIKE ?");
    params.push(`%${range.sessionId}%`);
  }
  if (range.status) {
    clauses.push("CAST(request_logs.status AS TEXT) = ?");
    params.push(range.status);
  }
  return { where: clauses.join(" AND "), params };
}

function addAppLog(db: Db, entry: Row): void {
  db.prepare(`
    INSERT INTO app_logs (level, scope, action, status, message, created_at)
    VALUES (@level, @scope, @action, @status, @message, @created_at)
  `).run({
    level: entry.level || "info",
    scope: entry.scope || null,
    action: entry.action || null,
    status: entry.status || null,
    message: String(entry.message || ""),
    created_at: now()
  });
}

function getLastRefreshAllUsageAt(db: Db): number {
  const setting = db.prepare("SELECT value FROM settings WHERE key = ?").get("last_usage_refresh_all_at");
  const settingTime = Number(setting?.value || 0);
  if (Number.isFinite(settingTime) && settingTime > 0) return Math.trunc(settingTime);
  const row = db.prepare(`
    SELECT MAX(created_at) AS created_at
    FROM app_logs
    WHERE scope = 'usage' AND action = 'refresh-all' AND status = 'success'
  `).get();
  const logTime = Number(row?.created_at || 0);
  return Number.isFinite(logTime) ? Math.trunc(logTime) : 0;
}

function repairLastRefreshAllUsageAt(db: Db): void {
  const setting = db.prepare("SELECT value FROM settings WHERE key = ?").get("last_usage_refresh_all_at");
  const settingTime = Number(setting?.value || 0);
  if (!Number.isFinite(settingTime) || settingTime <= 0) return;
  const matchingLogs = db.prepare(`
    SELECT status FROM app_logs
    WHERE scope = 'usage' AND action = 'refresh-all' AND created_at = ?
  `).all(Math.trunc(settingTime));
  if (matchingLogs.length === 0 || matchingLogs.some((row: Row) => row.status === "success")) return;
  const successful = db.prepare(`
    SELECT MAX(created_at) AS created_at FROM app_logs
    WHERE scope = 'usage' AND action = 'refresh-all' AND status = 'success'
  `).get();
  const repaired = Number(successful?.created_at || 0);
  db.prepare("UPDATE settings SET value = ? WHERE key = ?")
    .run(String(Number.isFinite(repaired) ? Math.trunc(repaired) : 0), "last_usage_refresh_all_at");
}

function clearAppLogs(db: Db): { deleted: number } {
  const result = db.prepare("DELETE FROM app_logs").run();
  compactDatabase(db);
  return { deleted: Number(result.changes || 0) };
}

function runMaintenance(db: Db, targetDataDir: string): { requestLogsDeleted: number; appLogsDeleted: number; loginSessionsDeleted: number } {
  const settings = getSettings(db);
  const requestDays = clampInt(settings.request_log_retention_days, 30, 1, 3650);
  const appDays = clampInt(settings.app_log_retention_days, 14, 1, 3650);
  const current = now();
  const requestResult = db.prepare("DELETE FROM request_logs WHERE created_at < ?")
    .run(current - requestDays * 86400);
  const appResult = db.prepare("DELETE FROM app_logs WHERE created_at < ?")
    .run(current - appDays * 86400);
  const loginResult = db.prepare("DELETE FROM login_sessions WHERE updated_at < ?")
    .run(current - 7 * 86400);
  removeExpiredMigrationBackups(targetDataDir);
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  return {
    requestLogsDeleted: Number(requestResult.changes || 0),
    appLogsDeleted: Number(appResult.changes || 0),
    loginSessionsDeleted: Number(loginResult.changes || 0)
  };
}

function compactDatabase(db: Db): unknown {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  return { compacted: true };
}

function listAppLogs(db: Db, query: Partial<LogQuery> = {}): AppLogPage {
  const range = normalizeLogQuery(query);
  const clauses = ["created_at >= ?", "created_at < ?"];
  const params: unknown[] = [range.startAt, range.endAt];
  if (range.level) {
    clauses.push("level = ?");
    params.push(range.level);
  }
  if (range.scope) {
    clauses.push("scope LIKE ?");
    params.push(`%${range.scope}%`);
  }
  if (range.status) {
    clauses.push("status LIKE ?");
    params.push(`%${range.status}%`);
  }
  if (range.keyword) {
    clauses.push("(message LIKE ? OR action LIKE ? OR scope LIKE ?)");
    params.push(`%${range.keyword}%`, `%${range.keyword}%`, `%${range.keyword}%`);
  }
  const where = clauses.join(" AND ");
  const items = db.prepare(`
    SELECT * FROM app_logs
    WHERE ${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params, range.pageSize, range.offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total FROM app_logs WHERE ${where}
  `).get(...params).total;
  return {
    items,
    total,
    page: range.page,
    pageSize: range.pageSize,
    startAt: range.startAt,
    endAt: range.endAt,
    query: logQueryFromRange(range)
  };
}

function logQueryFromRange(range: ReturnType<typeof normalizeLogQuery>): LogQuery {
  return {
    page: range.page,
    pageSize: range.pageSize,
    startAt: range.startAt,
    endAt: range.endAt,
    ...(range.accountId ? { accountId: range.accountId } : {}),
    ...(range.upstreamId ? { upstreamId: range.upstreamId } : {}),
    ...(range.clientModel ? { clientModel: range.clientModel } : {}),
    ...(range.upstreamModel ? { upstreamModel: range.upstreamModel } : {}),
    ...(range.sessionId ? { sessionId: range.sessionId } : {}),
    ...(range.status ? { status: range.status } : {}),
    ...(range.keyword ? { keyword: range.keyword } : {}),
    ...(range.level ? { level: range.level } : {}),
    ...(range.scope ? { scope: range.scope } : {})
  };
}

function normalizeLogQuery(query: Partial<LogQuery> = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const page = clampInt(query.page, 1, 1, 100000);
  const pageSize = clampInt(query.pageSize, 10, 5, 200);
  const startAt = clampInt(query.startAt, Math.floor(today.getTime() / 1000), 0, 4102444800);
  const endAt = clampInt(query.endAt, Math.floor(tomorrow.getTime() / 1000), startAt + 1, 4102444800);
  return {
    page,
    pageSize,
    startAt,
    endAt,
    accountId: cleanFilterValue(query.accountId),
    upstreamId: cleanFilterValue(query.upstreamId),
    clientModel: cleanFilterValue(query.clientModel),
    upstreamModel: cleanFilterValue(query.upstreamModel),
    sessionId: cleanFilterValue(query.sessionId),
    status: cleanFilterValue(query.status),
    keyword: cleanFilterValue(query.keyword),
    level: cleanFilterValue(query.level).toLowerCase(),
    scope: cleanFilterValue(query.scope),
    offset: (page - 1) * pageSize
  };
}

function cleanFilterValue(value: unknown): string {
  const text = String(value || "").trim();
  return text ? text.slice(0, 240) : "";
}

function cleanSessionName(value: unknown): string {
  const text = String(value || "").trim();
  return text ? text.slice(0, 120) : "";
}

function cleanSessionNote(value: unknown): string | null {
  const text = String(value || "").trim();
  return text ? text.slice(0, 1000) : null;
}

function normalizeAttemptChainJson(value: unknown): string | null {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return null;
    const chain = parsed.slice(0, 64).map((entry, index) => {
      const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Row : {};
      const status = Number(source.status);
      return {
        attempt: clampInt(source.attempt, index + 1, 1, 64),
        targetId: cleanFilterValue(source.targetId),
        targetName: cleanFilterValue(source.targetName),
        kind: cleanFilterValue(source.kind),
        outcome: cleanFilterValue(source.outcome),
        ...(Number.isFinite(status) && status > 0 ? { status: Math.trunc(status) } : {}),
        fallbackReason: cleanFilterValue(source.fallbackReason)
      };
    });
    return JSON.stringify(chain);
  } catch {
    return null;
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function toInt(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
