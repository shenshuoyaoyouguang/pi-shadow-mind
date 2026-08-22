import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig, serializeConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("uses v1 defaults", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.defaultShadowTimeoutSeconds).toBe(300);
  });

  it("parses gatekeeper_model and tolerates deprecated keys via extraFields", () => {
    const config = parseConfig({
      gatekeeper_model: "zhipu/glm-4.7-flash",
      heartbeat_probability: 0.9,
      random_seed: 7,
    });
    expect(config.gatekeeperModel).toBe("zhipu/glm-4.7-flash");
    expect(config.extraFields?.heartbeat_probability).toBe(0.9);
    expect(config.extraFields?.random_seed).toBe(7);
  });

  it("round-trips deprecated keys without writing them as known fields", () => {
    const text = serializeConfig(parseConfig({ heartbeat_probability: 0.5 }));
    expect(text).not.toContain('"heartbeat_probability": 0.5,\n    "max_parallel_shadows"');
    const reparsed = parseConfig(JSON.parse(text));
    expect(reparsed.extraFields?.heartbeat_probability).toBe(0.5);
  });

  it("rejects an invalid gatekeeper_model", () => {
    expect(() => parseConfig({ gatekeeper_model: "   " })).toThrow(/gatekeeper_model/);
  });

  it("#11 preserves unknown config keys across round-trip", () => {
    const parsed = parseConfig({ unknown_custom: "keep-me", another: 123 } as any);
    expect((parsed as any).extraFields).toEqual({ unknown_custom: "keep-me", another: 123 });
  });

  it("#11 config unknown fields survive serialize/parse", async () => {
    const cfg: any = { ...DEFAULT_CONFIG, extraFields: { my_extra: "value42", num: 7 } };
    const serialized = serializeConfig(cfg);
    expect(serialized).toContain("my_extra");
    expect(serialized).toContain("value42");
    const reparsed = parseConfig(JSON.parse(serialized));
    expect((reparsed as any).extraFields).toMatchObject({ my_extra: "value42", num: 7 });
  });
});
