import { describe, expect, it } from "vitest";
import { KERNEL_WASM_READY } from "../src/generated/kernel-wasm.js";
import * as tsScheduler from "../src/scheduler.js";
import * as tsUsage from "../src/usage.js";
import * as tsValidation from "../src/validation.js";
import * as tsSummaries from "../src/summaries.js";
import * as tsTrajectory from "../src/trajectory.js";
import * as tsProtocol from "../src/protocol.js";
import * as tsConfig from "../src/config.js";
import * as tsRegistry from "../src/registry.js";
import * as tsGatekeeper from "../src/gatekeeper.js";
import * as wasm from "../src/wasm-kernel.js";
import type { ShadowConfig, ShadowDefinition, ShadowTrigger } from "../src/types.js";
import type { ShadowUsage } from "../src/usage.js";

// Parity tests: same inputs through the TypeScript implementations and the
// WASM kernel must produce equal outputs. Skipped locally until a real WASM
// build exists (KERNEL_WASM_READY); CI builds the kernel and runs these.

const shadow: ShadowDefinition = {
  id: "reviewer",
  name: "Reviewer",
  enabled: true,
  debug: false,
  trigger: ["heartbeat"],
  activeForModels: ["*"],
  tools: [],
  activationTools: [],
  prompt: "Review code changes.",
  filePath: "shadows/reviewer.md",
};

const config: ShadowConfig = {
  heartbeatTools: ["read", "write"],
  maxParallelShadows: 2,
  defaultShadowTimeoutSeconds: 120,
  headlessDrainTimeoutSeconds: 5,
  resultBatchWindowMs: 500,
  excludedExtensions: [],
  defaultThinkingLevel: "low",
};

const usage: ShadowUsage = {
  requests: 1,
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

describe.skipIf(!KERNEL_WASM_READY)("wasm parity: scheduler", () => {
  it("extractToolNames", () => {
    const input = [{ toolName: "read" }, { toolName: "  " }, { foo: "bar" }, null];
    expect(wasm.extractToolNames(input)).toEqual(tsScheduler.extractToolNames(input));
  });

  it("shouldEvaluateHeartbeat", () => {
    expect(wasm.shouldEvaluateHeartbeat(["read", "write"], ["read"]))
      .toBe(tsScheduler.shouldEvaluateHeartbeat(["read", "write"], ["read"]));
    expect(wasm.shouldEvaluateHeartbeat(new Set(["read"]), []))
      .toBe(tsScheduler.shouldEvaluateHeartbeat(new Set(["read"]), []));
  });

  it("shouldEvaluateFinalResponse", () => {
    const msgs = [{ role: "assistant", content: "hello" }];
    expect(wasm.shouldEvaluateFinalResponse(msgs)).toBe(tsScheduler.shouldEvaluateFinalResponse(msgs));
  });

  it("selectCandidates", () => {
    const options = {
      shadows: [shadow, { ...shadow, id: "b", enabled: false }],
      activeShadowIds: new Set<string>(),
      mainModelId: "zhipu/glm-4.7",
      executedTools: new Set(["read"]),
    };
    expect(wasm.selectCandidates(options)).toEqual(tsScheduler.selectCandidates(options));
  });

  it("selectCandidates buckets", () => {
    const options = {
      shadows: [
        shadow,
        { ...shadow, id: "dis", enabled: false },
        { ...shadow, id: "run" },
        { ...shadow, id: "mismatch", activeForModels: ["other/model"] },
        { ...shadow, id: "tool", activationTools: ["write"] },
      ],
      activeShadowIds: new Set(["run"]),
      mainModelId: "zhipu/glm-4.7",
      executedTools: new Set(["read"]),
    };
    expect(wasm.selectCandidates(options)).toEqual(tsScheduler.selectCandidates(options));
  });

  it("decideFinalResponse", () => {
    const options = {
      shadows: [{ ...shadow, trigger: ["final_response"] as ShadowTrigger[] }],
      mainModelId: "zhipu/glm-4.7",
    };
    expect(wasm.decideFinalResponse(options)).toEqual(tsScheduler.decideFinalResponse(options));
  });

  it("matchesModel", () => {
    expect(wasm.matchesModel(shadow, "zhipu/glm-4.7")).toBe(tsScheduler.matchesModel(shadow, "zhipu/glm-4.7"));
    const neg = { ...shadow, activeForModels: ["!zhipu/*"] };
    expect(wasm.matchesModel(neg, "zhipu/glm-4.7")).toBe(tsScheduler.matchesModel(neg, "zhipu/glm-4.7"));
  });

  it("matchesActivationTools", () => {
    expect(wasm.matchesActivationTools(shadow, new Set(["read"])))
      .toBe(tsScheduler.matchesActivationTools(shadow, new Set(["read"])));
    const withTools = { ...shadow, activationTools: ["write"] };
    expect(wasm.matchesActivationTools(withTools, new Set(["read"])))
      .toBe(tsScheduler.matchesActivationTools(withTools, new Set(["read"])));
  });
});

describe.skipIf(!KERNEL_WASM_READY)("wasm parity: usage", () => {
  it("zeroUsage", () => {
    expect(wasm.zeroUsage()).toEqual(tsUsage.zeroUsage());
  });

  it("addUsage", () => {
    const other: ShadowUsage = { ...usage, requests: 2, input: 200 };
    expect(wasm.addUsage(usage, other)).toEqual(tsUsage.addUsage(usage, other));
  });

  it("formatUsageTokens", () => {
    expect(wasm.formatUsageTokens(1234)).toBe(tsUsage.formatUsageTokens(1234));
  });

  it("formatUsageCost", () => {
    expect(wasm.formatUsageCost(0.005)).toBe(tsUsage.formatUsageCost(0.005));
  });

  it("formatUsageSummary", () => {
    expect(wasm.formatUsageSummary(usage)).toBe(tsUsage.formatUsageSummary(usage));
  });

  it("formatUsageDetail", () => {
    expect(wasm.formatUsageDetail("total", usage)).toBe(tsUsage.formatUsageDetail("total", usage));
  });
});

describe.skipIf(!KERNEL_WASM_READY)("wasm parity: validation", () => {
  it("cleanStringArray", () => {
    expect(wasm.cleanStringArray(["a", "b"], ["x"], "test"))
      .toEqual(tsValidation.cleanStringArray(["a", "b"], ["x"], "test"));
    expect(wasm.cleanStringArray(undefined, ["x"], "test"))
      .toEqual(tsValidation.cleanStringArray(undefined, ["x"], "test"));
  });

  it("cleanStringArray null throws on both", () => {
    expect(() => wasm.cleanStringArray(null, ["x"], "test")).toThrow();
    expect(() => tsValidation.cleanStringArray(null, ["x"], "test")).toThrow();
  });

  it("isThinkingLevel", () => {
    expect(wasm.isThinkingLevel("low")).toBe(tsValidation.isThinkingLevel("low"));
    expect(wasm.isThinkingLevel("nope")).toBe(tsValidation.isThinkingLevel("nope"));
  });

  it("isStringArray", () => {
    expect(wasm.isStringArray(["a", "b"])).toBe(tsValidation.isStringArray(["a", "b"]));
    expect(wasm.isStringArray("x")).toBe(tsValidation.isStringArray("x"));
  });
});

describe.skipIf(!KERNEL_WASM_READY)("wasm parity: summaries/trajectory/protocol", () => {
  it("summarizeToolResult", () => {
    const result = { toolName: "read", content: "line1\nline2\nline3" };
    expect(wasm.summarizeToolResult(result)).toBe(tsSummaries.summarizeToolResult(result));
  });

  it("serializeTrajectory", () => {
    const messages = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
    expect(wasm.serializeTrajectory(messages)).toBe(tsTrajectory.serializeTrajectory(messages));
  });

  it("buildShadowRequest", () => {
    expect(wasm.buildShadowRequest("TRAJ", shadow, "brief text"))
      .toBe(tsProtocol.buildShadowRequest("TRAJ", shadow, "brief text"));
    expect(wasm.buildShadowRequest("TRAJ", shadow)).toBe(tsProtocol.buildShadowRequest("TRAJ", shadow));
  });
});

describe.skipIf(!KERNEL_WASM_READY)("wasm parity: config/registry", () => {
  it("parseConfig", () => {
    const input = { heartbeat_tools: ["bash", "edit"], max_parallel_shadows: 3 };
    expect(wasm.parseConfig(input)).toEqual(tsConfig.parseConfig(input));
  });

  it("parseConfig preserves extraFields", () => {
    const input = { heartbeat_tools: ["bash"], custom_key: "value", another: 42 };
    expect(wasm.parseConfig(input)).toEqual(tsConfig.parseConfig(input));
  });

  it("serializeConfig", () => {
    expect(wasm.serializeConfig(config)).toBe(tsConfig.serializeConfig(config));
  });

  it("parseShadowDefinition", () => {
    const meta = { id: "x", name: "X", active_for_models: ["*"] };
    expect(wasm.parseShadowDefinition(meta, "do things", "shadows/x.md", "x"))
      .toEqual(tsRegistry.parseShadowDefinition(meta, "do things", "shadows/x.md", "x"));
  });
});

describe.skipIf(!KERNEL_WASM_READY)("wasm parity: gatekeeper", () => {
  it("buildGatekeeperPrompt", () => {
    expect(wasm.buildGatekeeperPrompt([shadow], "TRAJ"))
      .toEqual(tsGatekeeper.buildGatekeeperPrompt([shadow], "TRAJ"));
  });

  it("fitTrajectory", () => {
    expect(wasm.fitTrajectory("USER: task\nMAIN: a\nMAIN: b", 1000))
      .toEqual(tsGatekeeper.fitTrajectory("USER: task\nMAIN: a\nMAIN: b", 1000));
    const long = "USER: task\n" + "MAIN: x\n".repeat(50);
    expect(wasm.fitTrajectory(long, 40)).toEqual(tsGatekeeper.fitTrajectory(long, 40));
  });

  it("parseGatekeeperReply", () => {
    const reply = '{"activations":[{"id":"reviewer","brief":"x"}]}';
    expect(wasm.parseGatekeeperReply(reply, new Set(["reviewer"])))
      .toEqual(tsGatekeeper.parseGatekeeperReply(reply, new Set(["reviewer"])));
  });
});
