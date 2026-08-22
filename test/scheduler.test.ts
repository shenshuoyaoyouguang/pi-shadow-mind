import { describe, expect, it } from "vitest";
import { matchesModel, selectCandidates, shouldEvaluateHeartbeat } from "../src/scheduler.js";
import type { ShadowDefinition } from "../src/types.js";

const shadow = (id: string, probability = 1): ShadowDefinition => ({
  id, name: id, enabled: true, debug: false, activationProbability: probability,
  activeForModels: ["openai/gpt"], tools: [], prompt: id, filePath: `${id}.md`,
});

describe("shouldEvaluateHeartbeat", () => {
  it("suppresses pure conversation turns", () => {
    expect(shouldEvaluateHeartbeat([])).toBe(false);
  });

  it("allows turns that completed Main tool work", () => {
    expect(shouldEvaluateHeartbeat([{ toolName: "read" }])).toBe(true);
  });
});

describe("matchesModel", () => {
  it("defaults a missing activeForModels list to match every model", () => {
    const { activeForModels: _omitted, ...bare } = shadow("a");
    expect(matchesModel(bare as ShadowDefinition, "openai/gpt")).toBe(true);
  });

  it("matches exact model ids and rejects non-matching ones", () => {
    const scoped = { ...shadow("a"), activeForModels: ["anthropic/claude"] };
    expect(matchesModel(scoped, "openai/gpt")).toBe(false);
    expect(matchesModel({ ...scoped, activeForModels: ["openai/gpt"] }, "openai/gpt")).toBe(true);
  });
});

describe("selectCandidates", () => {
  const base = { name: "n", prompt: "p", filePath: "f", enabled: true, activeForModels: ["*"] } as any;

  it("keeps enabled, non-running, model-matching shadows", () => {
    const shadows = [
      { ...base, id: "a" },
      { ...base, id: "b", enabled: false },
      { ...base, id: "c", activeForModels: ["m/1"] },
    ];
    const result = selectCandidates({ shadows, activeShadowIds: new Set(["a"]), mainModelId: "m/1" });
    expect(result.candidates.map((s) => s.id)).toEqual(["c"]);
    expect(result.runningExcluded).toEqual(["a"]);
    expect(result.disabled).toEqual(["b"]);
    expect(result.modelFiltered).toEqual([]);
  });

  it("reports disabled and model-mismatched shadows in separate buckets", () => {
    const shadows = [
      { ...base, id: "off", enabled: false },
      { ...base, id: "wrongmodel", activeForModels: ["other/1"] },
    ];
    const result = selectCandidates({ shadows, activeShadowIds: new Set(), mainModelId: "m/1" });
    expect(result.disabled).toEqual(["off"]);
    expect(result.modelFiltered).toEqual(["wrongmodel"]);
  });

  it("returns everything when nothing is excluded", () => {
    const result = selectCandidates({ shadows: [{ ...base, id: "x" }], activeShadowIds: new Set(), mainModelId: "m/1" });
    expect(result.candidates.map((s) => s.id)).toEqual(["x"]);
  });
});
