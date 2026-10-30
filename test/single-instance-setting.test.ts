import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { readSingleInstanceSetting } from "../src/main/single-instance.ts";
import { createStore } from "../src/main/store.ts";
import { createSecretCodec } from "../src/main/secret-codec.ts";
import { editableSettingsPatch } from "../src/main/renderer-boundary.ts";

test("启动读取默认开启单实例，可读取已保存的关闭和恢复配置", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-single-instance-"));
  const dbPath = path.join(directory, "test.sqlite");
  const store = createStore({
    dataDir: directory,
    dbPath,
    secretCodec: createSecretCodec({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString()
    })
  });
  try {
    assert.equal(store.getSettings().single_instance, "true");
    assert.equal(readSingleInstanceSetting(dbPath), true);
    store.saveSettings(editableSettingsPatch({ single_instance: "false" }));
    assert.equal(readSingleInstanceSetting(dbPath), false);
    store.saveSettings(editableSettingsPatch({ single_instance: "true" }));
    assert.equal(readSingleInstanceSetting(dbPath), true);
    assert.throws(() => editableSettingsPatch({ single_instance: "invalid" }));
    store.db.prepare("DELETE FROM settings WHERE key = ?").run("single_instance");
    assert.equal(readSingleInstanceSetting(dbPath), true);
    store.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("single_instance", "invalid");
    assert.equal(readSingleInstanceSetting(dbPath), true);
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("启动读取不会创建数据库，旧库或损坏配置保留单实例限制", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-single-instance-default-"));
  const dbPath = path.join(directory, "test.sqlite");
  try {
    assert.equal(readSingleInstanceSetting(dbPath), true);
    assert.equal(fs.existsSync(dbPath), false);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE legacy (id INTEGER)");
    db.close();
    assert.equal(readSingleInstanceSetting(dbPath), true);
    fs.writeFileSync(dbPath, "invalid database");
    assert.equal(readSingleInstanceSetting(dbPath), true);
    assert.equal(fs.readFileSync(dbPath, "utf8"), "invalid database");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
