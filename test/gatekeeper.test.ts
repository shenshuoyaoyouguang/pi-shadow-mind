import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  buildGatekeeperPrompt,
  fitTrajectory,
  GATEKEEPER_BRIEF_CHARS,
  parseGatekeeperReply,
  runGatekeeper,
} from "../src/gatekeeper.js";

const fakeModel = { provider: "test", id: "m", contextWindow: 100_000 } as unknown as Model<any>;
const config = { defaultThinkingLevel: "low" } as any;

function makeCandidate(id: string, prompt = "check facts") {
  return { id, name: id, prompt } as any;
}

describe("parseGatekeeperReply", () => {
  const ids = new Set(["a", "b"]);

  it("parses a plain JSON object", () => {
    expect(parseGatekeeperReply('{"activations":[{"id":"a","brief":"x"}]}', ids))
      .toEqual([{ id: "a", brief: "x" }]);
  });

  it("parses JSON inside a markdown fence", () => {
    const text = '```json\n{"activations":[{"id":"b"}]}\n```';
    expect(parseGatekeeperReply(text, ids)).toEqual([{ id: "b", brief: "" }]);
  });

  it("extracts the first JSON object from surrounding prose", () => {
    const text = 'Sure! {"activations":[{"id":"a","brief":"y"},{"id":"a","brief":"dup"},{"id":"ghost"}]}';
    expect(parseGatekeeperReply(text, ids)).toEqual([{ id: "a", brief: "y" }]);
  });

  it("throws on non-JSON or non-array activations", () => {
    expect(() => parseGatekeeperReply("no json", ids)).toThrow();
    expect(() => parseGatekeeperReply('{"activations":"nope"}', ids)).toThrow();
  });
});

describe("fitTrajectory", () => {
  it("returns input unchanged when it fits", () => {
    expect(fitTrajectory("USER: hi\nMAIN: ok", 1000)).toEqual({ text: "USER: hi\nMAIN: ok", truncated: false });
  });

  it("keeps the first USER segment plus the tail and flags truncation", () => {
    const segments = ["USER: original task", "MAIN: a", "MAIN: b", "TOOL: read(x)", "TOOL: write(y)"];
    const trajectory = segments.join("\n");
    const result = fitTrajectory(trajectory, 40);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("USER: original task");
    expect(result.text).toContain("TOOL: write(y)");
    expect(result.text).not.toContain("MAIN: a\n");
    expect(result.text.length).toBeLessThanOrEqual(40 + 64); // budget + omission marker
  });
});

describe("buildGatekeeperPrompt", () => {
  it("lists candidates with truncated responsibilities and includes trajectory", () => {
    const long = "x".repeat(GATEKEEPER_BRIEF_CHARS + 100);
    const { systemPrompt, userMessage } = buildGatekeeperPrompt([makeCandidate("a", long)], "TRAJ");
    expect(userMessage).toContain("- a | a | " + "x".repeat(GATEKEEPER_BRIEF_CHARS));
    expect(userMessage).toContain("TRAJ");
    expect(systemPrompt).toContain("JSON");
  });
});

describe("runGatekeeper", () => {
  const deps = (reply: string) => ({
    complete: async () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] }),
    resolveModel: () => fakeModel,
    modelAuthOk: () => true,
  } as any);

  it("returns parsed activations on success", async () => {
    const outcome = await runGatekeeper({
      candidates: [makeCandidate("a")],
      trajectory: "USER: hi",
      config,
      mainModel: fakeModel,
      deps: deps('{"activations":[{"id":"a","brief":"go"}]}'),
    });
    expect(outcome).toEqual({ ok: true, activations: [{ id: "a", brief: "go" }] });
  });

  it("fails closed on invalid reply", async () => {
    const outcome = await runGatekeeper({
      candidates: [makeCandidate("a")], trajectory: "T", config, mainModel: fakeModel, deps: deps("garbage"),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.activations).toEqual([]);
    expect(outcome.error).toBeTruthy();
  });

  it("fails when explicitly configured model cannot be resolved", async () => {
    const outcome = await runGatekeeper({
      candidates: [makeCandidate("a")], trajectory: "T",
      config: { ...config, gatekeeperModel: "nope/missing" } as any, mainModel: fakeModel,
      deps: { ...deps("{}"), resolveModel: () => undefined },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("nope/missing");
  });

  it("fails when model has no auth", async () => {
    const outcome = await runGatekeeper({
      candidates: [makeCandidate("a")], trajectory: "T", config, mainModel: fakeModel,
      deps: { ...deps("{}"), modelAuthOk: () => false },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("auth");
  });

  it("propagates truncation flag", async () => {
    // Brief's original fixture used the 100k-token fake window whose ~360k-char
    // budget can never be exceeded by an 1.8k-char trajectory; use a tiny window
    // so truncation actually triggers.
    const tinyWindowModel = { provider: "test", id: "m", contextWindow: 400 } as unknown as Model<any>;
    const longTrajectory = "USER: t\n" + "TOOL: x\n".repeat(200);
    const outcome = await runGatekeeper({
      candidates: [makeCandidate("a")], trajectory: longTrajectory, config, mainModel: tinyWindowModel,
      deps: deps('{"activations":[]}'),
    });
    expect(outcome.truncated).toBe(true);
  });
});
