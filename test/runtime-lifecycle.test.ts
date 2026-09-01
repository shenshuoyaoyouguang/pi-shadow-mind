import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShadowMindRuntime } from "../src/runtime.js";
import type { ShadowRunResult } from "../src/shadow-runner.js";
import type { ShadowDefinition } from "../src/types.js";
import { zeroUsage, type ShadowUsage } from "../src/usage.js";

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

interface RuntimeInternals {
  active: Map<string, { shadow: ShadowDefinition; epoch: number }>;
  epoch: number;
  recentRuns: unknown[];
  sessionUsage: ShadowUsage;
  usageStore: {
    add: (usage: ShadowUsage) => Promise<void>;
  };
  registerEvents: () => void;
  handleRunEnd: (runId: string, shadow: ShadowDefinition, result: ShadowRunResult) => void;
}

const shadow: ShadowDefinition = {
  id: "shadow-1",
  name: "Review",
  enabled: true,
  debug: false,
  activeForModels: [],
  tools: [],
  prompt: "Review",
  filePath: "review.md",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ShadowMindRuntime session lifecycle", () => {
  it.each(["reload", "new", "resume", "fork"])(
    "bounds %s session shutdown and detaches an unsettled old run",
    async (reason) => {
      vi.useFakeTimers();
      const handlers = new Map<string, EventHandler>();
      const runtime = new ShadowMindRuntime({
        on: (name: string, handler: EventHandler) => {
          handlers.set(name, handler);
        },
      } as unknown as ExtensionAPI);
      const internals = runtime as unknown as RuntimeInternals;
      internals.active.set("old-run", { shadow, epoch: 0 });
      internals.registerEvents();

      const context = {
        mode: "interactive",
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
        },
      } as unknown as ExtensionContext;
      const shutdown = handlers.get("session_shutdown");
      expect(shutdown).toBeDefined();

      const pending = shutdown!({ reason }, context);
      await vi.advanceTimersByTimeAsync(999);
      expect(internals.active.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(internals.active.size).toBe(0);
    },
  );

  it("persists a stale run without adding it to the new session quota", async () => {
    const runtime = new ShadowMindRuntime({} as ExtensionAPI);
    const internals = runtime as unknown as RuntimeInternals;
    const persisted: ShadowUsage[] = [];
    internals.usageStore.add = async (usage) => {
      persisted.push(usage);
    };
    internals.epoch = 2;
    internals.active.set("old-run", { shadow, epoch: 1 });
    const usage = zeroUsage();
    usage.requests = 1;
    usage.input = 42;
    usage.totalTokens = 42;

    internals.handleRunEnd("old-run", shadow, runResult(usage));

    expect(persisted).toEqual([usage]);
    expect(internals.sessionUsage).toEqual(zeroUsage());
    expect(internals.recentRuns).toHaveLength(0);
  });
});

function runResult(usage: ShadowUsage): ShadowRunResult {
  return {
    reason: "aborted",
    durationMs: 100,
    toolNames: [],
    missingTools: [],
    toolCalls: 0,
    toolFailures: 0,
    toolStats: [],
    usage,
  };
}
