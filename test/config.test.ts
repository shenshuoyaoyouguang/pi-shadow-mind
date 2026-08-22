import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig, serializeConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("uses v1 defaults", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.defaultShadowTimeoutSeconds).toBe(300);
  });

  it("rejects invalid probability", () => {
    expect(() => parseConfig({ heartbeat_probability: 2 })).toThrow(/heartbeat_probability/);
  });

  it("accepts a deterministic benchmark seed", () => {
    expect(parseConfig({ random_seed: 42 }).randomSeed).toBe(42);
    expect(() => parseConfig({ random_seed: -1 })).toThrow(/random_seed/);
    expect(() => parseConfig({ random_seed: 1.5 })).toThrow(/random_seed/);
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
