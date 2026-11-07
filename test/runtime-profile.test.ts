import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import {
  codexAccessOptions,
  createRuntimeProfile
} from "../src/main/runtime-profile.ts";

const projectRoot = path.resolve("test-fixture-project");

test("isolated development profile separates runtime state and service ports", () => {
  const profile = createRuntimeProfile({
    argv: ["electron", ".", "--isolated-dev"],
    isPackaged: false,
    projectRoot
  });

  assert.equal(profile.mode, "isolated-dev");
  assert.equal(profile.useSingleInstance, true);
  assert.equal(profile.allowServiceAutoStart, true);
  assert.equal(profile.allowStartupIntegration, false);
  assert.equal(profile.allowLiveCodexAccess, false);
  assert.equal(profile.appName, "Codexia v1 Dev");
  assert.equal(profile.appUserModelId, "io.github.jadchene.codexia.v1-dev");
  assert.equal(profile.windowTitle, "Codexia · v1 Dev");
  assert.equal(profile.rendererDevOrigin, "http://127.0.0.1:18435");
  assert.equal(profile.paths.dataDir, path.join(projectRoot, ".runtime", "v1-dev"));
  assert.equal(profile.paths.browserDataDir, path.join(projectRoot, ".runtime", "v1-dev", "browser"));
  assert.equal(profile.paths.dbPath, path.join(projectRoot, ".runtime", "v1-dev", "codex-gateway.sqlite"));
  assert.deepEqual(profile.settingsOverrides, {
    gateway_host: "127.0.0.1",
    gateway_port: "18436",
    mcp_gateway_host: "127.0.0.1",
    mcp_gateway_port: "13000",
  });
});

test("packaged build ignores the isolated flag and keeps production single-instance behavior", () => {
  const profile = createRuntimeProfile({
    argv: ["codexia.exe", "--isolated-dev"],
    isPackaged: true,
    projectRoot
  });

  assert.equal(profile.mode, "production");
  assert.equal(profile.isolated, false);
  assert.equal(profile.rejectedPackagedFlag, true);
  assert.equal(profile.useSingleInstance, true);
  assert.equal(profile.allowServiceAutoStart, true);
  assert.equal(profile.allowStartupIntegration, true);
  assert.equal(profile.allowLiveCodexAccess, true);
  assert.equal(profile.appName, "Codexia");
  assert.equal(profile.appUserModelId, "io.github.jadchene.codexia");
  assert.equal(profile.windowTitle, "Codexia");
  assert.equal(profile.paths, null);
});

test("isolated development blocks the live Codex directory by default", () => {
  const profile = createRuntimeProfile({
    argv: ["electron", ".", "--isolated-dev"],
    isPackaged: false,
    projectRoot
  });

  assert.throws(
    () => codexAccessOptions(profile),
    (error) => error?.code === "DEV_PROFILE_WRITE_BLOCKED"
  );
});

test("isolated development accepts an explicit Codex fixture inside its runtime directory", () => {
  const profile = createRuntimeProfile({
    argv: ["electron", ".", "--isolated-dev", "--codex-test-dir=.runtime/v1-dev/codex-e2e"],
    isPackaged: false,
    projectRoot
  });

  assert.deepEqual(codexAccessOptions(profile), {
    codexDir: path.join(projectRoot, ".runtime", "v1-dev", "codex-e2e")
  });
});

test("isolated development rejects a Codex test directory outside its runtime directory", () => {
  assert.throws(
    () => createRuntimeProfile({
      argv: ["electron", ".", "--isolated-dev", "--codex-test-dir=../live-codex"],
      isPackaged: false,
      projectRoot
    }),
    (error) => error?.code === "DEV_CODEX_DIR_OUTSIDE_RUNTIME"
  );
});
