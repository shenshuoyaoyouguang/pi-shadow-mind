import { describe, expect, it } from "vitest";
import { decideHeartbeat, matchesModel, selectCandidates, shouldEvaluateHeartbeat } from "../src/scheduler.js";
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

describe("decideHeartbeat", () => {
  it("rolls independently and caps selected shadows", () => {
    const rolls = [0.1, 0.1, 0.2, 0.3, 0.8, 0.4];
    const result = decideHeartbeat({
      heartbeatProbability: 1 / 3,
      availableSlots: 2,
      shadows: [shadow("a"), shadow("b"), shadow("c")],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      random: () => rolls.shift() ?? 0,
    });
    expect(result.activated).toHaveLength(2);
    expect(result.candidates).toHaveLength(3);
  });

  it("does nothing when heartbeat misses", () => {
    const result = decideHeartbeat({ heartbeatProbability: 0.3, availableSlots: 2, shadows: [shadow("a")], activeShadowIds: new Set(), mainModelId: "openai/gpt", random: () => 0.5 });
    expect(result.activated).toEqual([]);
  });

  it("reports running-excluded and model-filtered shadows", () => {
    const result = decideHeartbeat({
      heartbeatProbability: 1,
      availableSlots: 2,
      shadows: [shadow("a"), shadow("b")],
      activeShadowIds: new Set(["a"]),
      mainModelId: "other/model",
      random: () => 0.1,
    });
    expect(result.runningExcluded).toEqual(["a"]);
    expect(result.modelFiltered).toEqual(["b"]);
    expect(result.activated).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("does not consume shuffle randoms when hits fit the available slots", () => {
    let calls = 0;
    const result = decideHeartbeat({
      heartbeatProbability: 1,
      availableSlots: 2,
      shadows: [shadow("a"), shadow("b")],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      random: () => {
        calls += 1;
        return 0.1;
      },
    });
    expect(result.activated.map(({ shadow }) => shadow.id)).toEqual(["a", "b"]);
    expect(calls).toBe(3);
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
    expect(result.modelFiltered).toEqual(["b"]);
  });

  it("returns everything when nothing is excluded", () => {
    const result = selectCandidates({ shadows: [{ ...base, id: "x" }], activeShadowIds: new Set(), mainModelId: "m/1" });
    expect(result.candidates.map((s) => s.id)).toEqual(["x"]);
  });
});
