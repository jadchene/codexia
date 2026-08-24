import { describe, expect, it } from "vitest";
import type { IpcChannel } from "../src/shared/contracts/ipc";
import { ipcArgumentSchemas } from "../src/shared/schemas/ipc";

describe("IPC runtime argument schemas", () => {
  it("covers the current channel contract without removed features", () => {
    const channels = Object.keys(ipcArgumentSchemas) as IpcChannel[];
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels).toContain("upstreams:save");
    expect(channels).toContain("upstreams:refreshBalance");
    expect(channels).toContain("upstreams:bundledOverride");
    expect(channels).toContain("upstreams:saveBundledOverride");
    expect(channels).toContain("upstreams:refreshBuiltinModels");
    expect(channels).toContain("upstreams:modelManagement");
    expect(channels).toContain("upstreams:saveModelManagement");
    expect(channels.some((channel) => channel.startsWith("modelMappings:"))).toBe(false);
    expect(channels.some((channel) => channel.startsWith("routing:"))).toBe(false);
    expect(channels.some((channel) => channel.startsWith("sessions:"))).toBe(false);
  });

  it("rejects invalid IDs", () => {
    expect(ipcArgumentSchemas["upstreams:models"].safeParse([""]).success).toBe(false);
    expect(ipcArgumentSchemas["upstreams:testInvocation"].safeParse(["upstream-a", ""]).success).toBe(false);
    expect(ipcArgumentSchemas["upstreams:saveBundledOverride"].safeParse([{ enabled: true, modelCatalogJson: "{}" }]).success).toBe(true);
    expect(ipcArgumentSchemas["upstreams:saveBundledOverride"].safeParse([{ enabled: "true", modelCatalogJson: "{}" }]).success).toBe(false);
    const model = { slug: "model-a", displayName: "Model A", enabled: true };
    expect(ipcArgumentSchemas["upstreams:saveModelManagement"].safeParse([[model]]).success).toBe(true);
    expect(ipcArgumentSchemas["upstreams:saveModelManagement"].safeParse([[model, model]]).success).toBe(false);
    expect(ipcArgumentSchemas["upstreams:saveModelManagement"].safeParse([[{ ...model, displayName: "" }]]).success).toBe(false);
  });
});
