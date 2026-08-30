import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebouncedPersistence } from "../src/main/gateway";
import { parseFontconfig, parseMacFontProfiler, parseWindowsFontRegistry } from "../src/main/system-fonts";
import { clientReachableUrl, localServiceUrl } from "../src/renderer/lib/service-url";
import { settingsRestartReminder } from "../src/renderer/lib/settings-restart";

describe("audit fixes", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces routing persistence and flushes the newest snapshot", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const persistence = createDebouncedPersistence((value) => writes.push(value), 500, () => undefined);
    persistence.schedule("one");
    persistence.schedule("two");
    vi.advanceTimersByTime(499);
    expect(writes).toEqual([]);
    persistence.flush();
    expect(writes).toEqual(["two"]);
    vi.advanceTimersByTime(1_000);
    expect(writes).toEqual(["two"]);
  });

  it("turns wildcard listener URLs into client-reachable loopback URLs", () => {
    expect(clientReachableUrl("http://0.0.0.0:8436")).toBe("http://127.0.0.1:8436");
    expect(clientReachableUrl("http://[::]:8436/mcp")).toBe("http://127.0.0.1:8436/mcp");
    expect(localServiceUrl("http", "::1", "8436", "/v1")).toBe("http://[::1]:8436/v1");
  });

  it("only asks to restart the service whose startup-bound setting changed", () => {
    expect(settingsRestartReminder({ gateway_port: "8436" }, { gateway_port: "8437" }, true, false))
      .toContain("API 服务");
    expect(settingsRestartReminder({ ignore_five_hour_limit: "false" }, { ignore_five_hour_limit: "true" }, true, true))
      .toBe("");
    expect(settingsRestartReminder({ mcp_gateway_path: "/mcp" }, { mcp_gateway_path: "/next" }, false, true))
      .toContain("MCP 服务");
  });

  it("extracts installed font family names from each supported platform format", () => {
    expect(parseWindowsFontRegistry("    Example Sans (TrueType)    REG_SZ    example.ttf\n"))
      .toEqual(["Example Sans"]);
    expect(parseMacFontProfiler(JSON.stringify({ SPFontsDataType: [{ typefaces: [{ family: "Example Serif" }] }] })))
      .toEqual(["Example Serif"]);
    expect(parseFontconfig("Noto Sans,Noto Sans CJK SC\nDejaVu Sans\n"))
      .toEqual(["Noto Sans", "Noto Sans CJK SC", "DejaVu Sans", ""]);
  });
});
