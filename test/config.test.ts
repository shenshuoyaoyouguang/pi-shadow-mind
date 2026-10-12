import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig, serializeConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("uses built-in defaults", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.defaultShadowTimeoutSeconds).toBe(300);
    expect(DEFAULT_CONFIG.heartbeatTools).toEqual([]);
  });

  it("parses and deduplicates heartbeat_tools", () => {
    const config = parseConfig({ heartbeat_tools: ["bash", "edit", "bash"] });
    expect(config.heartbeatTools).toEqual(["bash", "edit"]);
  });

  it("rejects invalid heartbeat_tools", () => {
    expect(() => parseConfig({ heartbeat_tools: "not-an-array" })).toThrow(
      /heartbeat_tools/,
    );
    expect(() => parseConfig({ heartbeat_tools: [""] })).toThrow(
      /heartbeat_tools/,
    );
  });

  it("serializes heartbeat_tools only when non-empty", () => {
    const withTools = serializeConfig({
      ...DEFAULT_CONFIG,
      heartbeatTools: ["bash", "write"],
    });
    expect(withTools).toContain('"heartbeat_tools": [\n    "bash",\n    "write"\n  ]');

    const defaultEmpty = serializeConfig(DEFAULT_CONFIG);
    expect(defaultEmpty).not.toContain("heartbeat_tools");
  });

  it("excludes session-recording extensions by default", () => {
    expect(DEFAULT_CONFIG.excludedExtensions).toEqual(["pi-experiencev2"]);
    expect(parseConfig({}).excludedExtensions).toEqual(["pi-experiencev2"]);
  });

  it("lets an empty excluded_extensions survive a write/read round trip", () => {
    const cleared = { ...DEFAULT_CONFIG, excludedExtensions: [] };
    const serialized = serializeConfig(cleared);
    expect(serialized).toContain('"excluded_extensions": []');
    expect(parseConfig(JSON.parse(serialized)).excludedExtensions).toEqual([]);
  });

  it("rejects invalid excluded_extensions", () => {
    expect(parseConfig({ excluded_extensions: ["a", "a", "b"] }).excludedExtensions).toEqual([
      "a",
      "b",
    ]);
    expect(() => parseConfig({ excluded_extensions: "pi-experiencev2" })).toThrow(
      /excluded_extensions/,
    );
    expect(() => parseConfig({ excluded_extensions: [""] })).toThrow(/excluded_extensions/);
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
    expect(text).toContain("heartbeat_probability");
    expect(text).not.toMatch(/"heartbeat_probability":\s*0\.5,\s*"max_parallel_shadows"/);
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

  it("preserves a __proto__ unknown key instead of routing it through the setter", () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "unknown_custom": "keep-me"}');
    const parsed = parseConfig(raw);
    expect(Object.getOwnPropertyNames(parsed.extraFields)).toContain("__proto__");
    expect((parsed.extraFields as any).__proto__).toEqual({ polluted: true });
    const serialized = serializeConfig(parsed);
    expect(serialized).toContain("__proto__");
    const reparsed = parseConfig(JSON.parse(serialized));
    expect(Object.getOwnPropertyNames(reparsed.extraFields)).toContain("__proto__");
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
