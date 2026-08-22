import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { ShadowRunner, type ShadowRunRequest } from "../src/shadow-runner.js";

// ---------------------------------------------------------------------------
// Mock only createAgentSession; everything else (pre-checks, bootstrap, report
// tool, metrics, result building) runs for real. The fake session faithfully
// simulates the AgentSession surface the runner depends on.
// ---------------------------------------------------------------------------

const mock = vi.hoisted(() => {
  class FakeSession {
    messages: Record<string, unknown>[] = [
      // Simulates the injected main-session trajectory (tool results present).
      { role: "toolResult", toolName: "read", isError: false, toolCallId: "traj-1" },
      { role: "toolResult", toolName: "grep", isError: false, toolCallId: "traj-2" },
    ];
    sessionFile = "/tmp/fake/session.jsonl";
    aborted = false;
    disposed = false;
    behavior: "silent" | "report" | "empty-report" | "empty-then-report" | "double-report" | "report-then-hang" | "tools" | "throw" | "hang" = "silent";
    promptError: Error | undefined;
    options: any;
    private release?: (err?: Error) => void;

    constructor(options: any) {
      this.options = options;
    }

    getActiveToolNames(): string[] {
      return (this.options.tools ?? []).filter((name: string) => !name.startsWith("missing-"));
    }

    async prompt(): Promise<void> {
      const reportTool = () => this.options.customTools?.find((tool: any) => tool.name === "report_to_main");
      const callReport = async (toolCallId: string, content: string) => {
        const result = await reportTool().execute(toolCallId, { content }, undefined, undefined, {} as any);
        return result.terminate === true;
      };
      if (this.behavior === "hang") {
        await new Promise<void>((resolve, reject) => {
          this.release = (err) => (err ? reject(err) : resolve());
        });
        return;
      }
      if (this.behavior === "throw") {
        throw this.promptError ?? new Error("prompt failed");
      }
      if (this.behavior === "report") {
        // Simulate the model calling the (real) built-in report_to_main tool.
        await callReport("call-1", "found a smell");
        return;
      }
      if (this.behavior === "empty-report") {
        await callReport("call-1", "   ");
        return;
      }
      if (this.behavior === "empty-then-report") {
        if (await callReport("call-1", "   ")) return;
        await callReport("call-2", "found after retry");
        return;
      }
      if (this.behavior === "double-report") {
        await callReport("call-1", "first");
        await callReport("call-2", "second");
        return;
      }
      if (this.behavior === "report-then-hang") {
        await callReport("call-1", "delivered before timeout");
        await new Promise<void>((resolve, reject) => {
          this.release = (err) => (err ? reject(err) : resolve());
        });
        return;
      }
      if (this.behavior === "tools") {
        // Shadow's own tool calls, appended after the trajectory.
        this.messages.push({ role: "toolResult", toolName: "write", isError: false, toolCallId: "own-1" });
        this.messages.push({ role: "toolResult", toolName: "write", isError: true, toolCallId: "own-2" });
      }
    }

    async waitForIdle(): Promise<void> {}

    abort(): void {
      this.aborted = true;
      this.release?.(new Error("aborted"));
    }

    dispose(): void {
      this.disposed = true;
    }
  }
  return { FakeSession, sessions: [] as FakeSession[], createAgentSession: vi.fn() };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: mock.createAgentSession };
});

const fakeModel = {
  provider: "test", id: "model", api: "openai-completions", baseUrl: "http://test", reasoning: true,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000, maxTokens: 1000,
  thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high" },
} as any;

let tmp: string;
let behavior: InstanceType<typeof mock.FakeSession>["behavior"] = "silent";
let promptError: Error | undefined;

function makeRequest(overrides: Partial<ShadowRunRequest> = {}): ShadowRunRequest {
  return {
    shadow: { id: "s", name: "S", enabled: true, debug: false, activationProbability: 0.5, activeForModels: ["*"], tools: [], prompt: "test", filePath: "s.md" },
    config: { heartbeatProbability: 1 / 3, maxParallelShadows: 2, defaultShadowTimeoutSeconds: 60, headlessDrainTimeoutSeconds: 120, resultBatchWindowMs: 400, defaultThinkingLevel: "low" },
    epoch: 1,
    runId: "run-1",
    cwd: tmp,
    agentDir: tmp,
    mainSystemPrompt: "system prompt",
    messages: [],
    mainModel: fakeModel,
    tools: ["read", "report_to_main"],
    resolveModel: () => fakeModel,
    modelAuthOk: () => true,
    mainThinkingLevel: "high",
    onReport: vi.fn(),
    ...overrides,
  };
}

describe("ShadowRunner.run integration", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shadow-test-"));
    behavior = "silent";
    promptError = undefined;
    mock.sessions.length = 0;
    mock.createAgentSession.mockReset();
    mock.createAgentSession.mockImplementation(async (options: any) => {
      const session = new mock.FakeSession(options);
      session.behavior = behavior;
      session.promptError = promptError;
      mock.sessions.push(session);
      return { session, extensionsResult: {} as any };
    });
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("runs silently: no report, empty metrics, session disposed", async () => {
    const runner = new ShadowRunner();
    const onReport = vi.fn();
    const result = await runner.run(makeRequest({ onReport }));
    expect(result.reason).toBe("silent");
    expect(result.toolCalls).toBe(0);
    expect(result.toolStats).toEqual([]);
    expect(result.sessionFile).toBe("/tmp/fake/session.jsonl");
    expect(onReport).not.toHaveBeenCalled();
    expect(mock.sessions[0].disposed).toBe(true);
  });

  it("delivers a report through the real report_to_main tool and ends the run", async () => {
    const runner = new ShadowRunner();
    const onReport = vi.fn();
    behavior = "report";
    const result = await runner.run(makeRequest({ onReport }));
    const session = mock.sessions[0];
    expect(result.reason).toBe("report");
    expect(result.thinkingLevel).toBe("high");
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({
      shadowId: "s", shadowName: "S", content: "found a smell", epoch: 1, runId: "run-1",
    }));
    expect(session.aborted).toBe(true);
    expect(session.disposed).toBe(true);
  });

  it("counts only the shadow's own tool results, excluding the injected trajectory", async () => {
    const runner = new ShadowRunner();
    behavior = "tools";
    const result = await runner.run(makeRequest());
    expect(result.reason).toBe("silent");
    expect(result.toolCalls).toBe(2);
    expect(result.toolFailures).toBe(1);
    expect(result.toolStats).toEqual([{ tool: "write", calls: 2, failures: 1 }]);
  });

  it("reports missing tools that did not materialize in the session", async () => {
    const runner = new ShadowRunner();
    const result = await runner.run(makeRequest({ tools: ["read", "missing-x", "report_to_main"] }));
    expect(result.missingTools).toEqual(["missing-x"]);
  });

  it("resolves the thinking level with fallback and passes it to createAgentSession", async () => {
    const runner = new ShadowRunner();
    const result = await runner.run(makeRequest({ shadow: { ...makeRequest().shadow, thinkingLevel: "medium" } }));
    expect(result.thinkingLevel).toBe("high");
    expect(mock.sessions[0].options.thinkingLevel).toBe("high");
  });

  it("times out: aborts the session and returns timeout without reporting", async () => {
    const runner = new ShadowRunner();
    const onReport = vi.fn();
    behavior = "hang";
    const result = await runner.run(makeRequest({ onReport, config: { ...makeRequest().config, defaultShadowTimeoutSeconds: 0.05 } }));
    const session = mock.sessions[0];
    expect(result.reason).toBe("timeout");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(session.aborted).toBe(true);
    expect(onReport).not.toHaveBeenCalled();
  });

  it("propagates prompt errors as run errors", async () => {
    const runner = new ShadowRunner();
    behavior = "throw";
    promptError = new Error("boom");
    const result = await runner.run(makeRequest());
    const session = mock.sessions[0];
    expect(result.reason).toBe("error");
    expect(result.error).toBe("boom");
    expect(session.disposed).toBe(true);
  });

  it("reports aborted when the run is cancelled externally", async () => {
    const runner = new ShadowRunner();
    behavior = "hang";
    const pending = runner.run(makeRequest({ runId: "run-abort" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    runner.abort("run-abort");
    const result = await pending;
    const session = mock.sessions[0];
    expect(result.reason).toBe("aborted");
    expect(session.aborted).toBe(true);
    expect(result.toolCalls).toBe(0);
  });

  it("accepts trajectories that fit under the chars/4 token estimate", async () => {
    const runner = new ShadowRunner();
    // ~200k serialized chars: chars/2 falsely estimated ~100k > 100000 window.
    const result = await runner.run(makeRequest({
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(200000) }] }],
    }));
    expect(result.reason).toBe("silent");
    expect(result.error).toBeUndefined();
  });

  it("still rejects trajectories exceeding the context window under the relaxed estimate", async () => {
    const runner = new ShadowRunner();
    const result = await runner.run(makeRequest({
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(400000) }] }],
    }));
    expect(result.reason).toBe("error");
    expect(result.error).toMatch(/exceeds test\/model context window \(100000\)/);
  });

  it("treats an empty report as silence instead of delivering it", async () => {
    const runner = new ShadowRunner();
    const onReport = vi.fn();
    behavior = "empty-report";
    const result = await runner.run(makeRequest({ onReport }));
    expect(result.reason).toBe("silent");
    expect(onReport).not.toHaveBeenCalled();
  });

  it("allows retry after report_to_main rejects empty content", async () => {
    const runner = new ShadowRunner();
    const onReport = vi.fn();
    behavior = "empty-then-report";
    const result = await runner.run(makeRequest({ onReport }));
    expect(result.reason).toBe("report");
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ content: "found after retry" }));
  });

  it("classifies a delivered report as report even when the timeout races", async () => {
    const runner = new ShadowRunner();
    const onReport = vi.fn();
    behavior = "report-then-hang";
    const result = await runner.run(makeRequest({ onReport, config: { ...makeRequest().config, defaultShadowTimeoutSeconds: 0.05 } }));
    expect(result.reason).toBe("report");
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ content: "delivered before timeout" }));
  });

  it("delivers at most one report when report_to_main fires repeatedly", async () => {
    const runner = new ShadowRunner();
    const onReport = vi.fn();
    behavior = "double-report";
    const result = await runner.run(makeRequest({ onReport }));
    expect(result.reason).toBe("report");
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ content: "first" }));
  });
});
