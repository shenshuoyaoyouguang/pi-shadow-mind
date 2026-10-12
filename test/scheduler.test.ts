import { describe, expect, it } from "vitest";
import { FinalResponseBudget } from "../src/final-response-budget.js";
import {
  decideFinalResponse,
  extractToolNames,
  matchesActivationTools,
  matchesModel,
  selectCandidates,
  shouldEvaluateFinalResponse,
  shouldEvaluateHeartbeat,
} from "../src/scheduler.js";
import type { ShadowDefinition } from "../src/types.js";

const shadow = (
  id: string,
  trigger: ShadowDefinition["trigger"] = ["heartbeat"],
  activationTools: string[] = [],
  finalResponseRounds?: number,
): ShadowDefinition => ({
  id,
  name: id,
  enabled: true,
  debug: false,
  trigger,
  activeForModels: ["openai/gpt"],
  ...(finalResponseRounds === undefined ? {} : { finalResponseRounds }),
  tools: [],
  activationTools,
  prompt: id,
  filePath: `${id}.md`,
});

describe("shouldEvaluateHeartbeat", () => {
  it("suppresses pure conversation turns", () => {
    expect(shouldEvaluateHeartbeat([])).toBe(false);
  });

  it("allows turns that completed Main tool work", () => {
    expect(shouldEvaluateHeartbeat([{ toolName: "read" }])).toBe(true);
  });

  it("respects heartbeatTools filter", () => {
    expect(
      shouldEvaluateHeartbeat([{ toolName: "read" }], ["bash", "write"]),
    ).toBe(false);
    expect(
      shouldEvaluateHeartbeat([{ toolName: "bash" }], ["bash", "write"]),
    ).toBe(true);
    expect(
      shouldEvaluateHeartbeat(
        [{ toolName: "read" }, { toolName: "write" }],
        ["bash", "write"],
      ),
    ).toBe(true);
  });
});

describe("extractToolNames", () => {
  it("extracts and trims valid tool names", () => {
    const names = extractToolNames([
      { toolName: "bash" },
      { toolName: " edit " },
      null,
      {},
      { toolName: "" },
    ]);
    expect(names).toEqual(new Set(["bash", "edit"]));
  });
});

describe("matchesActivationTools", () => {
  it("allows all when activationTools is empty", () => {
    const s = shadow("s");
    expect(matchesActivationTools(s, ["read"])).toBe(true);
    expect(matchesActivationTools(s, undefined)).toBe(true);
  });

  it("requires intersection when activationTools is specified", () => {
    const s = shadow("s", ["heartbeat"], ["bash", "edit", "write"]);
    expect(matchesActivationTools(s, ["read"])).toBe(false);
    expect(matchesActivationTools(s, ["read", "edit"])).toBe(true);
  });
});

describe("shouldEvaluateFinalResponse", () => {
  it("accepts an agent run ending with final assistant text", () => {
    expect(
      shouldEvaluateFinalResponse([
        { role: "user", content: "task" },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ]),
    ).toBe(true);
  });

  it("rejects tool-only, empty, and aborted endings", () => {
    expect(
      shouldEvaluateFinalResponse([
        { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
      ]),
    ).toBe(false);
    expect(
      shouldEvaluateFinalResponse([
        { role: "assistant", content: [{ type: "text", text: "  " }] },
      ]),
    ).toBe(false);
    expect(shouldEvaluateFinalResponse([])).toBe(false);
  });
});

describe("matchesModel", () => {
  it("matches wildcard * for any model", () => {
    const s = { ...shadow("s"), activeForModels: ["*"] };
    expect(matchesModel(s, "openai-codex/gpt-6-astra")).toBe(true);
    expect(matchesModel(s, "anthropic/claude-3-7-sonnet")).toBe(true);
  });

  it("matches exact full model ID", () => {
    const s = { ...shadow("s"), activeForModels: ["openai-codex/gpt-6-astra"] };
    expect(matchesModel(s, "openai-codex/gpt-6-astra")).toBe(true);
    expect(matchesModel(s, "openai-codex/gpt-5.5")).toBe(false);
    expect(matchesModel(s, "anthropic/claude-3-7-sonnet")).toBe(false);
  });

  it("matches model ID without provider prefix", () => {
    const s = { ...shadow("s"), activeForModels: ["gpt-6-astra"] };
    expect(matchesModel(s, "openai-codex/gpt-6-astra")).toBe(true);
    expect(matchesModel(s, "custom-provider/gpt-6-astra")).toBe(true);
    expect(matchesModel(s, "openai-codex/gpt-5.5")).toBe(false);
  });

  it("supports wildcard patterns", () => {
    const s = { ...shadow("s"), activeForModels: ["anthropic/*"] };
    expect(matchesModel(s, "anthropic/claude-3-7-sonnet")).toBe(true);
    expect(matchesModel(s, "openai-codex/gpt-6-astra")).toBe(false);
  });

  it("excludes specific model by short name with wildcard (*, !shortName)", () => {
    const s = { ...shadow("s"), activeForModels: ["*", "!gpt-6-astra"] };
    expect(matchesModel(s, "openai-codex/gpt-6-astra")).toBe(false);
    expect(matchesModel(s, "anthropic/claude-3-7-sonnet")).toBe(true);
    expect(matchesModel(s, "deepseek/deepseek-chat")).toBe(true);
  });

  it("excludes specific model by full provider/model ID", () => {
    const s = {
      ...shadow("s"),
      activeForModels: ["*", "!openai-codex/gpt-6-astra"],
    };
    expect(matchesModel(s, "openai-codex/gpt-6-astra")).toBe(false);
    expect(matchesModel(s, "other-provider/gpt-6-astra")).toBe(true);
    expect(matchesModel(s, "openai-codex/gpt-5.5")).toBe(true);
  });

  it("supports pure exclusion without explicit * wildcard", () => {
    const s = { ...shadow("s"), activeForModels: ["!gpt-6-astra"] };
    expect(matchesModel(s, "openai-codex/gpt-6-astra")).toBe(false);
    expect(matchesModel(s, "anthropic/claude-3-7-sonnet")).toBe(true);
  });

  it("supports wildcard exclusions", () => {
    const s = { ...shadow("s"), activeForModels: ["*", "!*gpt*"] };
    expect(matchesModel(s, "openai-codex/gpt-6-astra")).toBe(false);
    expect(matchesModel(s, "openai/gpt-4o")).toBe(false);
    expect(matchesModel(s, "anthropic/claude-3-7-sonnet")).toBe(true);
  });

  it("rejects empty activeForModels or invalid entries", () => {
    const empty = { ...shadow("s"), activeForModels: [] };
    expect(matchesModel(empty, "openai-codex/gpt-6-astra")).toBe(false);

    const blankExclusion = {
      ...shadow("s"),
      activeForModels: ["*", "! ", " "],
    };
    expect(matchesModel(blankExclusion, "openai-codex/gpt-6-astra")).toBe(true);
  });

  it("integrates with scheduler decision to record excluded shadows in modelFiltered", () => {
    const excludedShadow = {
      ...shadow("reviewer", ["final_response"]),
      activeForModels: ["*", "!gpt-6-astra"],
    };
    const regularShadow = {
      ...shadow("general", ["final_response"]),
      activeForModels: ["*"],
    };

    const decisionAstra = decideFinalResponse({
      shadows: [excludedShadow, regularShadow],
      mainModelId: "openai-codex/gpt-6-astra",
    });
    expect(decisionAstra.modelFiltered).toEqual(["reviewer"]);
    expect(decisionAstra.activated.map((a) => a.shadow.id)).toEqual([
      "general",
    ]);

    const decisionClaude = decideFinalResponse({
      shadows: [excludedShadow, regularShadow],
      mainModelId: "anthropic/claude-3-7-sonnet",
    });
    expect(decisionClaude.modelFiltered).toEqual([]);
    expect(decisionClaude.activated.map((a) => a.shadow.id).sort()).toEqual([
      "general",
      "reviewer",
    ]);
  });
});

describe("selectCandidates", () => {
  const base = { name: "n", prompt: "p", filePath: "f", enabled: true, trigger: ["heartbeat"], activeForModels: ["*"], activationTools: [] } as any;

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

  it("filters shadows by activationTools and records toolFiltered", () => {
    const writeOnlyShadow = shadow("writer", ["heartbeat"], ["bash", "edit", "write"]);
    const generalShadow = shadow("general", ["heartbeat"], []);

    // Case 1: Only "read" was called -> writeOnlyShadow is toolFiltered
    const readTurnResult = selectCandidates({
      shadows: [writeOnlyShadow, generalShadow],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      executedTools: ["read"],
    });
    expect(readTurnResult.toolFiltered).toEqual(["writer"]);
    expect(readTurnResult.candidates.map((s) => s.id)).toEqual(["general"]);

    // Case 2: "edit" was called -> writeOnlyShadow passes the tool filter
    const editTurnResult = selectCandidates({
      shadows: [writeOnlyShadow, generalShadow],
      activeShadowIds: new Set(),
      mainModelId: "openai/gpt",
      executedTools: ["edit"],
    });
    expect(editTurnResult.toolFiltered).toEqual([]);
    expect(editTurnResult.candidates.map((s) => s.id).sort()).toEqual([
      "general",
      "writer",
    ]);
  });
});

describe("decideFinalResponse", () => {
  it("activates final-response shadows without probability rolls or activation-tools filtering", () => {
    const result = decideFinalResponse({
      shadows: [
        shadow("heartbeat"),
        shadow("final-a", ["final_response"], ["write"]),
        shadow("final-b", ["heartbeat", "final_response"], ["edit"]),
      ],
      mainModelId: "openai/gpt",
    });
    expect(result.activated.map(({ shadow }) => shadow.id)).toEqual([
      "final-a",
      "final-b",
    ]);
    expect(result.candidates.every(({ selected }) => selected)).toBe(true);
  });

  it("still applies enabled and model filters", () => {
    const disabled = {
      ...shadow("disabled", ["final_response"]),
      enabled: false,
    };
    const otherModel = {
      ...shadow("other", ["final_response"]),
      activeForModels: ["other/model"],
    };
    const result = decideFinalResponse({
      shadows: [disabled, otherModel],
      mainModelId: "openai/gpt",
    });
    expect(result.activated).toEqual([]);
    expect(result.modelFiltered).toEqual(["other"]);
  });

  it("filters a Shadow after its final-response round limit", () => {
    const limited = shadow("limited", ["final_response"], [], 1);
    const unlimited = shadow("unlimited", ["final_response"]);
    const budget = new FinalResponseBudget();
    budget.commit(["limited"]);
    const result = decideFinalResponse({
      shadows: [limited, unlimited],
      mainModelId: "openai/gpt",
      canRunFinalResponse: (candidate) => budget.canRun(candidate),
    });
    expect(result.activated.map(({ shadow }) => shadow.id)).toEqual([
      "unlimited",
    ]);
    expect(result.roundFiltered).toEqual(["limited"]);
  });
});
