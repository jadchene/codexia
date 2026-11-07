import { canonicalInstanceDirectory } from "./single-instance.ts";
import { ACCESS_MODES, type AccessMode, type AccessSelection, type CliBackend } from "./cli.ts";
import { ControlError, controlFile, readControlMetadata, requestLocalControl, startLocalControl, type ControlMetadata, type ControlOptions } from "./local-control.ts";

interface Snapshot {
  current: AccessSelection | null;
  show: string;
  choices: Record<AccessMode, ReturnType<CliBackend["choices"]>>;
  defaults: Record<AccessMode, ReturnType<CliBackend["defaults"]>>;
  gatewayRunning: boolean;
}
function validSelection(value: unknown): value is AccessSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return typeof s.mode === "string" && Object.hasOwn(ACCESS_MODES, s.mode)
    && typeof s.targetId === "string" && s.targetId.length <= 512
    && typeof s.proxy === "boolean" && typeof s.restart === "boolean"
    && (s.mode !== "gateway" || (!s.proxy && s.targetId === ""));
}
export function startCliControl(dataDir: string, backend: CliBackend, options: ControlOptions) {
  return startLocalControl(dataDir, {
    "access-mode.get": () => {
      const modes = Object.keys(ACCESS_MODES) as AccessMode[];
      return { current: backend.current?.() ?? null, show: backend.show(), gatewayRunning: backend.gatewayRunning?.() ?? false,
        choices: Object.fromEntries(modes.map((mode) => [mode, backend.choices(mode)])),
        defaults: Object.fromEntries(modes.map((mode) => [mode, backend.defaults(mode)])) };
    },
    "access-mode.apply": async (params) => {
      if (!validSelection(params)) throw new ControlError("INVALID_PARAMS", "接入参数无效。");
      await backend.apply(params);
      return { gatewayRunning: backend.gatewayRunning?.() ?? false };
    }
  }, options);
}

export async function connectCliControl(dataDir: string, options: ControlOptions): Promise<CliBackend | null> {
  const connect = async (metadata: ControlMetadata): Promise<CliBackend | null> => {
    let snapshot: Snapshot;
    try { snapshot = await requestLocalControl<Snapshot>(metadata, options.appVersion, "access-mode.get"); }
    catch (error) { if (error instanceof ControlError && error.code === "UNAVAILABLE") return null; throw error; }
    if (!snapshot?.choices || !snapshot.defaults) throw new Error("Codexia 未返回接入配置。");
    let gatewayRunning = snapshot.gatewayRunning;
    return { current: () => snapshot.current, show: () => snapshot.show, choices: (mode) => snapshot.choices[mode], defaults: (mode) => snapshot.defaults[mode],
      gatewayRunning: () => gatewayRunning,
      apply: async (selection) => {
        gatewayRunning = (await requestLocalControl<{ gatewayRunning: boolean }>(metadata, options.appVersion, "access-mode.apply", selection)).gatewayRunning;
      } };
  };
  const directory = canonicalInstanceDirectory(dataDir);
  const local = readControlMetadata(controlFile(dataDir), true);
  if (local?.instanceDirectory === directory) {
    const service = await connect(local);
    if (service) return service;
  }
  return null;
}
