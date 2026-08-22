import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { ShadowRunner, type ShadowRunRequest } from "../src/shadow-runner.js";
import { ShadowMindRuntime } from "../src/runtime.js";
import type { runGatekeeper } from "../src/gatekeeper.js";

// ---------------------------------------------------------------------------
// Mock only the Pi boundary: getAgentDir points the runtime at a temp agent
// dir and createAgentSession is replaced so shadow runs can be controlled.
// Config parsing, registry loading, scheduling, batching and delivery all run
// for real against the temp dir.
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => {
  class FakeShadowSession {
    // Mirror the real AgentSession shape: production reads messages (base
    // count, own-message metrics) and sessionFile.
    messages: Record<string, unknown>[] = [];
    /** Prompt texts delivered to this session, for asserting request content. */
    prompts: string[] = [];
    sessionFile = "/tmp/fake-shadow-session.jsonl";
    behavior: "silent" | "hang" = "silent";
    constructor(readonly options: Record<string, unknown>) {}
    getActiveToolNames(): string[] {
      return ((this.options.tools as string[] | undefined) ?? []).filter((name) => !name.startsWith("missing-"));
    }
    async prompt(text?: string): Promise<void> {
      this.prompts.push(text ?? "");
      if (this.behavior === "hang") await new Promise<void>(() => {});
    }
    async waitForIdle(): Promise<void> {}
    abort(): void {}
    dispose(): void {}
  }
  return {
    FakeShadowSession,
    sessions: [] as FakeShadowSession[],
    createAgentSession: vi.fn(),
    getAgentDir: vi.fn(() => "/tmp/shadow-mind-runtime-test-unset"),
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: harness.createAgentSession, getAgentDir: harness.getAgentDir };
});

const fakeModel = {
  provider: "test", id: "model", api: "openai-completions", baseUrl: "http://test", reasoning: true,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000, maxTokens: 1000,
  // Must support "low" (ctx.thinkingLevel and the config default) or every run
  // fails in resolveRunThinkingLevel before a session exists.
  thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high" },
} as unknown as Model<any>;

interface RuntimeEventLog {
  kind?: string;
  data?: Record<string, unknown>;
}

let tmp: string;
let sessionBehavior: "silent" | "hang";

function makePi(failingEntryKinds: string[] = []) {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const shortcuts = new Map<string, (ctx: ExtensionContext) => void>();
  const sent: Array<{ customType: string; content: string }> = [];
  const events: RuntimeEventLog[] = [];
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => void }) => {
      shortcuts.set(key, options.handler);
    },
    registerMessageRenderer: vi.fn(),
    getAllTools: () => [{ name: "read" }, { name: "grep" }],
    sendMessage: (message: { customType: string; content: string }) => {
      sent.push(message);
    },
    appendEntry: (_customType: string, data?: RuntimeEventLog) => {
      if (data?.kind !== undefined && failingEntryKinds.includes(data.kind)) throw new Error("append failed");
      events.push(data ?? {});
    },
  };
  return { api: api as unknown as ExtensionAPI, handlers, shortcuts, sent, events, statuses, notifications };
}

type PiHarness = ReturnType<typeof makePi>;

function makeCtx(pi: PiHarness, overrides: Record<string, unknown> = {}): ExtensionContext {
  const ctx = {
    mode: "tui",
    cwd: tmp,
    ui: {
      notify: (message: string) => pi.notifications.push(message),
      setStatus: (_key: string, text: string | undefined) => pi.statuses.push(text),
      setWidget: vi.fn(),
    },
    sessionManager: { getEntries: () => [], getLeafId: () => undefined },
    modelRegistry: { hasConfiguredAuth: () => true, isUsingOAuth: () => true, find: () => fakeModel },
    model: fakeModel,
    thinkingLevel: "low",
    isIdle: () => true,
    hasPendingMessages: () => false,
    getSystemPrompt: () => "main system prompt",
    ...overrides,
  };
  return ctx as unknown as ExtensionContext;
}

function handlerOf(pi: PiHarness, event: string): (event: unknown, ctx: ExtensionContext) => unknown {
  const handler = pi.handlers.get(event)?.[0];
  if (!handler) throw new Error(`no ${event} handler registered`);
  return handler;
}

function fireTurnEnd(pi: PiHarness, ctx: ExtensionContext): Promise<unknown> {
  const event = {
    type: "turn_end",
    turnIndex: 0,
    message: {},
    toolResults: [{ role: "toolResult", toolName: "read", isError: false, toolCallId: "traj-1" }],
  };
  return Promise.resolve(handlerOf(pi, "turn_end")(event, ctx));
}

function fireInput(pi: PiHarness, ctx: ExtensionContext): void {
  handlerOf(pi, "input")({ type: "input", text: "next task", source: "user" }, ctx);
}

function togglePause(pi: PiHarness, ctx: ExtensionContext): void {
  const handler = pi.shortcuts.get("alt+s");
  if (!handler) throw new Error("alt+s shortcut not registered");
  handler(ctx);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until the condition holds; launches are fire-and-forget, so tests must wait for observable state. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await sleep(5);
  }
}

function writeConfig(overrides: Record<string, number> = {}): void {
  const dir = join(tmp, "shadow-minds");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    heartbeat_probability: 1,
    max_parallel_shadows: 2,
    default_shadow_timeout_seconds: 60,
    headless_drain_timeout_seconds: 120,
    result_batch_window_ms: 10,
    default_thinking_level: "low",
    ...overrides,
  }));
}

function writeShadow(id: string): void {
  const dir = join(tmp, "shadow-minds");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\nname: ${id}\nactivation_probability: 1\ntools: []\n---\nPrompt body for ${id}.\n`);
}

/** Default test gatekeeper: activate every candidate, mirroring the old probability=1 behavior. */
function defaultTestGatekeeper(options: { candidates: readonly { id: string }[] }): Promise<{ ok: true; activations: Array<{ id: string; brief: string }> }> {
  return Promise.resolve({
    ok: true,
    activations: options.candidates.map((shadow) => ({ id: shadow.id, brief: "" })),
  });
}

async function boot(options: { config?: Record<string, number>; shadows?: string[]; abortGraceMs?: number; failingEntryKinds?: string[]; gatekeeper?: typeof runGatekeeper } = {}) {
  writeConfig(options.config);
  for (const id of options.shadows ?? []) writeShadow(id);
  const pi = makePi(options.failingEntryKinds);
  const runtimeOptions: { abortGraceMs?: number; gatekeeper?: typeof runGatekeeper } = {};
  if (options.abortGraceMs !== undefined) runtimeOptions.abortGraceMs = options.abortGraceMs;
  runtimeOptions.gatekeeper = options.gatekeeper ?? defaultTestGatekeeper;
  const runtime = new ShadowMindRuntime(pi.api, runtimeOptions);
  runtime.register();
  const ctx = makeCtx(pi);
  await handlerOf(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
  return { pi, runtime, ctx };
}

/** Replaces ShadowRunner.run with a never-settling stub that exposes onReport. */
async function bootWithHeldRuns(options: Parameters<typeof boot>[0] = {}) {
  const booted = await boot(options);
  let onReport!: ShadowRunRequest["onReport"];
  const runSpy = vi.spyOn(ShadowRunner.prototype, "run").mockImplementation((request) => {
    onReport = request.onReport;
    return new Promise(() => {});
  });
  return { ...booted, runSpy, emit: (report: ShadowRunRequest["onReport"] extends (report: infer R) => void ? R : never) => onReport(report) };
}

describe("ShadowMindRuntime concurrency", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shadow-runtime-test-"));
    harness.getAgentDir.mockReturnValue(tmp);
    sessionBehavior = "hang";
    harness.sessions.length = 0;
    harness.createAgentSession.mockReset();
    harness.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => {
      const session = new harness.FakeShadowSession(options);
      session.behavior = sessionBehavior;
      harness.sessions.push(session);
      return { session, extensionsResult: {} };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("serializes concurrent turn_end heartbeats so parallel slots are not oversubscribed", async () => {
    const { pi, ctx } = await boot({ shadows: ["alpha", "beta"] });
    const first = fireTurnEnd(pi, ctx);
    const second = fireTurnEnd(pi, ctx);
    await Promise.all([first, second]);
    await waitFor(() => harness.sessions.length === 2);
    expect(harness.sessions).toHaveLength(2);
  });

  it("drops remaining launches when pause lands mid-heartbeat", async () => {
    const { pi } = await boot({ shadows: ["alpha"] });
    let pausingCtx!: ExtensionContext;
    pausingCtx = makeCtx(pi, {
      sessionManager: {
        getEntries: () => {
          togglePause(pi, pausingCtx);
          return [];
        },
        getLeafId: () => undefined,
      },
    });
    await fireTurnEnd(pi, pausingCtx);
    expect(harness.sessions).toHaveLength(0);
    expect(pi.notifications).toContain("Shadow Mind paused");
  });

  it("drops reports that arrive after pause instead of re-arming delivery", async () => {
    const { pi, ctx, emit } = await bootWithHeldRuns({ shadows: ["alpha"] });
    await fireTurnEnd(pi, ctx);
    emit({ shadowId: "alpha", shadowName: "alpha", content: "pre-pause finding", epoch: 0, runId: "run-1" });
    togglePause(pi, ctx);
    emit({ shadowId: "alpha", shadowName: "alpha", content: "post-pause finding", epoch: 0, runId: "run-1" });
    await sleep(40);
    expect(pi.sent).toEqual([]);
  });

  it("rejects stale-epoch reports after pause and resume", async () => {
    const { pi, ctx, emit } = await bootWithHeldRuns({ shadows: ["alpha"] });
    await fireTurnEnd(pi, ctx);
    togglePause(pi, ctx);
    togglePause(pi, ctx);
    emit({ shadowId: "alpha", shadowName: "alpha", content: "stale finding", epoch: 0, runId: "run-1" });
    await sleep(40);
    expect(pi.sent).toEqual([]);
  });

  it("records reports-dropped when new input aborts pending reports", async () => {
    const { pi, ctx, emit } = await bootWithHeldRuns({ shadows: ["alpha"] });
    await fireTurnEnd(pi, ctx);
    emit({ shadowId: "alpha", shadowName: "alpha", content: "pending finding", epoch: 0, runId: "run-1" });
    fireInput(pi, ctx);
    const dropped = pi.events.filter((event) => event.kind === "reports-dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.data).toMatchObject({ reason: "new-user-input", count: 1 });
  });

  it("force-releases the parallel slot when an aborted run never settles", async () => {
    const { pi, ctx } = await boot({ config: { max_parallel_shadows: 1 }, shadows: ["alpha", "beta"], abortGraceMs: 25 });
    await fireTurnEnd(pi, ctx);
    await waitFor(() => harness.sessions.length === 1);
    expect(harness.sessions).toHaveLength(1);
    fireInput(pi, ctx);
    await sleep(80);
    expect(pi.events.some((event) => event.kind === "run-watchdog-cleared")).toBe(true);
    await fireTurnEnd(pi, ctx);
    await waitFor(() => harness.sessions.length === 2);
    expect(harness.sessions).toHaveLength(2);
  });

  it("contains record failures in the run-end error path without unhandled rejections", async () => {
    const { pi, ctx } = await boot({ shadows: ["alpha"], failingEntryKinds: ["run-end"] });
    sessionBehavior = "silent";
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await fireTurnEnd(pi, ctx);
      await sleep(60);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it("force-clears orphaned slots when headless drain times out", async () => {
    const { pi, ctx } = await boot({ config: { headless_drain_timeout_seconds: 0.05 }, shadows: ["alpha"] });
    await fireTurnEnd(pi, ctx);
    await waitFor(() => harness.sessions.length === 1);
    expect(harness.sessions).toHaveLength(1);
    const shutdownCtx = makeCtx(pi, { mode: "print" });
    await handlerOf(pi, "session_shutdown")({ type: "session_shutdown", reason: "quit" }, shutdownCtx);
    const lastLaunchIndex = pi.statuses.lastIndexOf("🐙 1");
    expect(lastLaunchIndex).toBeGreaterThan(-1);
    expect(pi.statuses.indexOf("🐙 0", lastLaunchIndex)).toBeGreaterThan(-1);
  });

  it("cancels queued heartbeats after session shutdown", async () => {
    const { pi, runtime, ctx } = await boot({ shadows: ["alpha"] });
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshControl = { blocked: false };
    const runtimeWithRefresh = runtime as unknown as { refresh(ctx: ExtensionContext): Promise<void> };
    const originalRefresh = runtimeWithRefresh.refresh.bind(runtime);
    vi.spyOn(runtimeWithRefresh, "refresh").mockImplementation(async (refreshCtx) => {
      if (!refreshControl.blocked) {
        refreshControl.blocked = true;
        await refreshBlocked;
      }
      await originalRefresh(refreshCtx);
    });

    const first = fireTurnEnd(pi, ctx);
    await sleep(0);
    const second = fireTurnEnd(pi, ctx);
    await sleep(0);

    const shutdownCtx = makeCtx(pi);
    await handlerOf(pi, "session_shutdown")({ type: "session_shutdown", reason: "quit" }, shutdownCtx);
    releaseRefresh();

    await Promise.all([first, second]);
    await sleep(40);

    expect(harness.sessions).toHaveLength(0);
  });

  it("calls the gatekeeper and launches listed shadows with briefs", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const gatekeeper = async (options: { candidates: readonly { id: string }[]; trajectory: string; signal?: AbortSignal }) => {
      calls.push(options as unknown as Record<string, unknown>);
      return { ok: true as const, activations: [{ id: "alpha", brief: "check scheduler" }] };
    };
    const { pi, ctx } = await boot({ shadows: ["alpha"], gatekeeper });
    await fireTurnEnd(pi, ctx);
    await waitFor(() => harness.sessions.length === 1);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.candidates as Array<{ id: string }>).map((shadow) => shadow.id)).toEqual(["alpha"]);
    expect(typeof calls[0]!.trajectory).toBe("string");
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(harness.sessions[0]!.prompts[0]).toContain("唤醒理由（供参考）：check scheduler");
    const decision = pi.events.find((event) => event.kind === "gatekeeper-decision");
    expect(decision?.data).toMatchObject({ activated: [{ id: "alpha", brief: "check scheduler" }], candidates: ["alpha"] });
  });

  it("skips the gatekeeper when no candidates survive the prefilter", async () => {
    let called = false;
    const gatekeeper = async () => {
      called = true;
      return { ok: true as const, activations: [] };
    };
    const { pi, ctx } = await boot({ gatekeeper });
    await fireTurnEnd(pi, ctx);
    await sleep(20);
    expect(called).toBe(false);
    expect(pi.events.some((event) => event.kind === "heartbeat-skipped" && event.data?.reason === "no-candidates")).toBe(true);
    expect(pi.events.some((event) => event.kind === "run-start")).toBe(false);
  });

  it("fails closed on gatekeeper error and records the event", async () => {
    const gatekeeper = async () => ({ ok: false as const, activations: [], error: "boom" });
    const { pi, ctx } = await boot({ shadows: ["alpha"], gatekeeper });
    await fireTurnEnd(pi, ctx);
    await sleep(20);
    const errorEvent = pi.events.find((event) => event.kind === "gatekeeper-error");
    expect(errorEvent?.data).toMatchObject({ error: "boom" });
    expect(harness.sessions).toHaveLength(0);
  });

  it("aborts an in-flight gatekeeper call on new user input", async () => {
    let aborted = false;
    let entered = false;
    const gatekeeper = (options: { signal?: AbortSignal }) => new Promise<{ ok: true; activations: [] }>((_resolve, reject) => {
      entered = true;
      options.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
    const { pi, ctx } = await boot({ shadows: ["alpha"], gatekeeper });
    const pending = fireTurnEnd(pi, ctx);
    await waitFor(() => entered);
    fireInput(pi, ctx);
    await pending;
    await sleep(10);
    expect(aborted).toBe(true);
    expect(harness.sessions).toHaveLength(0);
  });
});
