# Gatekeeper Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用轻量 LLM 门卫替代两层随机抽签，由门卫读取净化轨迹与候选 Shadow 职责摘要，产出带 brief 的唤醒名单。

**Architecture:** 新模块 `src/gatekeeper.ts` 承载门卫全部逻辑（提示词、`completeSimple` 调用、JSON 解析、截断），`scheduler.ts` 退化为纯函数候选预筛，`runtime.ts` 只改编排（预筛→门卫→launch）。随机调度机制（`decideHeartbeat`、`sample`、`random.ts`）整体删除。

**Tech Stack:** TypeScript ESM（NodeNext，相对导入带 `.js`）、vitest globals、`@earendil-works/pi-ai` 的 `completeSimple`/`contentText`。

**Spec:** `docs/superpowers/specs/2026-08-22-gatekeeper-scheduler-design.md`

## Global Constraints

- 纯 ESM，NodeNext 模块解析：src 内相对导入必须带 `.js` 后缀。
- 构建目标 Node 20；`AbortSignal.any` / `AbortSignal.timeout` 可用。
- 提交前必须 `npm run verify`（typecheck + 全部测试）。
- 门卫失败 fail-closed：跳过本轮，不回退随机抽签。
- 废弃字段（`heartbeat_probability`、`random_seed`）宽容接受但忽略，无迁移逻辑，不自动改写用户文件。
- 测试用 vitest globals（`describe/it/expect` 直接可用，无需 import）。
- 每个 task 结束时测试全绿并 commit。

---

### Task 1: `buildShadowRequest` 支持 brief 注入

**Files:**
- Modify: `src/protocol.ts`
- Modify: `src/shadow-runner.ts`（`ShadowRunRequest` 增加 `brief?` 字段并透传）
- Test: `test/protocol.test.ts`

**Interfaces:**
- Consumes: 现有 `buildShadowRequest(trajectory, shadow)`。
- Produces: `buildShadowRequest(trajectory: string, shadow: ShadowDefinition, brief?: string): string`；`ShadowRunRequest.brief?: string`。Task 4 依赖两者。

- [ ] **Step 1: Write the failing test**

在 `test/protocol.test.ts` 追加：

```ts
describe("buildShadowRequest brief", () => {
  const shadow = { id: "a", name: "A", prompt: "do things" } as any;

  it("injects a neutral brief line when provided", () => {
    const result = buildShadowRequest("TRAJ", shadow, "main rewrote scheduler");
    expect(result).toContain("唤醒理由（供参考）：main rewrote scheduler");
    expect(result.indexOf("唤醒理由")).toBeGreaterThan(result.indexOf("<shadow-mind"));
  });

  it("keeps output identical when brief is omitted", () => {
    const result = buildShadowRequest("TRAJ", shadow);
    expect(result).not.toContain("唤醒理由");
    expect(result).toBe(buildShadowRequest("TRAJ", shadow, undefined));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/protocol.test.ts`
Expected: FAIL（`buildShadowRequest` 尚不接受第三参数，注入行不存在）

- [ ] **Step 3: Implement**

`src/protocol.ts`：

```ts
export function buildShadowRequest(trajectory: string, shadow: ShadowDefinition, brief?: string): string {
  const briefLine = brief ? `唤醒理由（供参考）：${brief}\n` : "";
  return `${trajectory}\n\n${RUNTIME_PROTOCOL}\n\n<shadow-mind id="${shadow.id}" name="${shadow.name}">\n${briefLine}${shadow.prompt}\n</shadow-mind>\n\n${KICKOFF}`;
}
```

`src/shadow-runner.ts`：`ShadowRunRequest` 增加 `brief?: string;`；`run()` 中改为 `await boot.session.prompt(buildShadowRequest(trajectory, request.shadow, request.brief));`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/protocol.test.ts && npx vitest run test/runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts src/shadow-runner.ts test/protocol.test.ts
git commit -m "feat: inject optional gatekeeper brief into shadow request"
```

---

### Task 2: 门卫模块 `src/gatekeeper.ts`

**Files:**
- Create: `src/gatekeeper.ts`
- Test: `test/gatekeeper.test.ts`（新建）

**Interfaces:**
- Consumes: `@earendil-works/pi-ai` 的 `completeSimple`、`contentText`；`resolveRunThinkingLevel`（`src/shadow-runner.ts`，已导出）；`ShadowConfig`/`ShadowDefinition`（`src/types.ts`）。
- Produces（Task 4 依赖）:
  - `runGatekeeper(options: RunGatekeeperOptions): Promise<GatekeeperOutcome>`
  - `GatekeeperOutcome { ok: boolean; activations: GatekeeperActivation[]; truncated?: boolean; error?: string }`
  - `GatekeeperActivation { id: string; brief: string }`
  - `RunGatekeeperOptions { candidates; trajectory; config; mainModel; mainThinkingLevel?; signal?; deps? }`
  - 纯函数 `parseGatekeeperReply(text, candidateIds)`、`fitTrajectory(text, contextWindowChars)`、`buildGatekeeperPrompt(candidates, trajectory)`
  - 常量 `GATEKEEPER_TIMEOUT_MS = 30_000`、`GATEKEEPER_BRIEF_CHARS = 400`

- [ ] **Step 1: Write the failing tests**

创建 `test/gatekeeper.test.ts`：

```ts
import { completeSimple, contentText } from "@earendil-works/pi-ai";
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
    const longTrajectory = "USER: t\n" + "TOOL: x\n".repeat(200);
    const outcome = await runGatekeeper({
      candidates: [makeCandidate("a")], trajectory: longTrajectory, config, mainModel: fakeModel,
      deps: deps('{"activations":[]}'),
    });
    expect(outcome.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/gatekeeper.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Implement `src/gatekeeper.ts`**

```ts
import { completeSimple, contentText } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolveRunThinkingLevel } from "./shadow-runner.js";
import type { ShadowConfig, ShadowDefinition } from "./types.js";

export const GATEKEEPER_TIMEOUT_MS = 30_000;
export const GATEKEEPER_BRIEF_CHARS = 400;

const OMISSION_MARKER = "[...earlier trajectory omitted...]";
const SEGMENT_START = /^(USER|MAIN|TOOL RESULT|TOOL):/;

const SYSTEM_PROMPT = `You are the Shadow Mind dispatcher. You decide which persistent Shadow Minds should be woken for the current main-agent turn.
You receive a candidate list (id | name | responsibility) and a sanitized trajectory of the main agent's recent activity.
Relevance means the trajectory touches the candidate's responsibility with something concrete to check or do. Routine chatter, trivial edits, and unrelated work are NOT relevant.
When in doubt, do not activate. Respond with ONLY a JSON object, no prose, no code fences:
{"activations":[{"id":"<candidate id>","brief":"<one sentence, in the trajectory's language, telling this Shadow what to focus on>"}]}
Use an empty list when no candidate is relevant.`;

export interface GatekeeperActivation { id: string; brief: string }

export interface GatekeeperOutcome {
  ok: boolean;
  activations: GatekeeperActivation[];
  truncated?: boolean;
  error?: string;
}

export interface GatekeeperDeps {
  complete: typeof completeSimple;
  resolveModel(fullModelId: string): Model<any> | undefined;
  modelAuthOk?(model: Model<any>): boolean;
}

export interface RunGatekeeperOptions {
  candidates: readonly ShadowDefinition[];
  trajectory: string;
  config: ShadowConfig;
  mainModel: Model<any>;
  mainThinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  deps?: Partial<GatekeeperDeps>;
}

export function buildGatekeeperPrompt(
  candidates: readonly ShadowDefinition[],
  trajectory: string,
): { systemPrompt: string; userMessage: string } {
  const list = candidates
    .map((shadow) => `- ${shadow.id} | ${shadow.name} | ${flatten(shadow.prompt).slice(0, GATEKEEPER_BRIEF_CHARS)}`)
    .join("\n");
  const userMessage = `Candidates:\n${list || "(none)"}\n\nTrajectory:\n${trajectory}\n\nDecide which candidates are relevant to this trajectory and respond with the JSON object.`;
  return { systemPrompt: SYSTEM_PROMPT, userMessage };
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** chars ≈ tokens × 4 with a 10% margin, matching shadow-runner's estimate. */
export function fitTrajectory(trajectory: string, contextWindowChars: number): { text: string; truncated: boolean } {
  if (trajectory.length <= contextWindowChars) return { text: trajectory, truncated: false };
  const lines = trajectory.split("\n");
  // Head = the first USER segment (original task intent). Everything after it competes for tail budget.
  let headEnd = lines.findIndex((line, index) => index > 0 && SEGMENT_START.test(line));
  if (headEnd < 0) headEnd = 0;
  const headLines = headEnd > 0 ? lines.slice(0, headEnd) : [];
  const headChars = headLines.join("\n").length;
  const tailLines: string[] = [];
  let tailChars = 0;
  for (let index = lines.length - 1; index >= headEnd; index -= 1) {
    const line = lines[index];
    if (tailChars + line.length + 1 > contextWindowChars - headChars) break;
    tailLines.unshift(line);
    tailChars += line.length + 1;
  }
  return { text: [...headLines, OMISSION_MARKER, ...tailLines].join("\n"), truncated: true };
}

export function parseGatekeeperReply(text: string, candidateIds: ReadonlySet<string>): GatekeeperActivation[] {
  const parsed = extractJson(text) as { activations?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.activations)) {
    throw new Error("gatekeeper reply has no activations array");
  }
  const seen = new Set<string>();
  const activations: GatekeeperActivation[] = [];
  for (const entry of parsed.activations) {
    if (!entry || typeof entry !== "object") continue;
    const { id, brief } = entry as { id?: unknown; brief?: unknown };
    if (typeof id !== "string" || !candidateIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    activations.push({ id, brief: typeof brief === "string" ? brief : "" });
  }
  return activations;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(source);
  } catch {
    // fall through to brace extraction
  }
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
  throw new Error("no JSON object in gatekeeper reply");
}

export async function runGatekeeper(options: RunGatekeeperOptions): Promise<GatekeeperOutcome> {
  const fail = (error: string): GatekeeperOutcome => ({ ok: false, activations: [], error });
  const deps: GatekeeperDeps = {
    complete: options.deps?.complete ?? completeSimple,
    resolveModel: options.deps?.resolveModel ?? (() => undefined),
    modelAuthOk: options.deps?.modelAuthOk,
  };
  const explicitId = options.config.gatekeeperModel ?? options.config.defaultShadowModel;
  let model = options.mainModel;
  if (explicitId) {
    model = deps.resolveModel(explicitId);
    if (!model) return fail(`gatekeeper model not found: ${explicitId}`);
  }
  if (deps.modelAuthOk && !deps.modelAuthOk(model)) {
    return fail(`gatekeeper model ${model.provider}/${model.id} has no configured auth`);
  }
  let thinkingLevel: ThinkingLevel | undefined;
  try {
    thinkingLevel = resolveRunThinkingLevel(model, {
      shadow: { thinkingLevel: undefined } as ShadowDefinition,
      config: options.config,
      mainThinkingLevel: options.mainThinkingLevel,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  // chars ≈ tokens × 4 with a 10% margin, matching shadow-runner's estimate.
  const fitted = fitTrajectory(options.trajectory, Math.floor(model.contextWindow * 4 * 0.9));
  const { systemPrompt, userMessage } = buildGatekeeperPrompt(options.candidates, fitted.text);
  const signals = [AbortSignal.timeout(GATEKEEPER_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  let message: AssistantMessage;
  try {
    message = await deps.complete(
      model,
      { systemPrompt, messages: [{ role: "user", content: userMessage }] },
      // pi-agent-core's ThinkingLevel adds "off", which pi-ai's reasoning option
      // does not accept; "off" maps to no reasoning request.
      { signal: AbortSignal.any(signals), reasoning: thinkingLevel === "off" ? undefined : thinkingLevel },
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return fail(message.errorMessage ?? `gatekeeper model stopped: ${message.stopReason}`);
  }
  try {
    const activations = parseGatekeeperReply(contentText(message.content), new Set(options.candidates.map((shadow) => shadow.id)));
    return { ok: true, activations, ...(fitted.truncated ? { truncated: true } : {}) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
```

注意：`resolveRunThinkingLevel` 的 `request.shadow` 仅读取 `thinkingLevel` 字段，stub 即可；若 typecheck 报缺字段，补 `as unknown as ShadowDefinition`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/gatekeeper.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gatekeeper.ts test/gatekeeper.test.ts
git commit -m "feat: add gatekeeper dispatch module"
```

---

### Task 3: `selectCandidates` 预筛（先加不删）

**Files:**
- Modify: `src/scheduler.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes: 现有 `matchesModel`。
- Produces（Task 4 依赖）: `selectCandidates(options: { shadows: readonly ShadowDefinition[]; activeShadowIds: ReadonlySet<string>; mainModelId: string }): { candidates: ShadowDefinition[]; modelFiltered: string[]; runningExcluded: string[] }`。本 task 暂不删除 `decideHeartbeat`（Task 4 删）。

- [ ] **Step 1: Write the failing tests**

在 `test/scheduler.test.ts` 追加（保留现有 `shouldEvaluateHeartbeat`/`matchesModel`/`decideHeartbeat` 测试，Task 4 再清理）：

```ts
describe("selectCandidates", () => {
  const base = { name: "n", prompt: "p", filePath: "f", enabled: true, activeForModels: ["*"] } as any;

  it("keeps enabled, non-running, model-matching shadows", () => {
    const shadows = [
      { ...base, id: "a" },
      { ...base, id: "b", enabled: false },
      { ...base, id: "c", activeForModels: ["other/model"] },
    ];
    const result = selectCandidates({ shadows, activeShadowIds: new Set(["a"]), mainModelId: "m/1" });
    expect(result.candidates.map((s) => s.id)).toEqual(["c"]);
    expect(result.runningExcluded).toEqual(["a"]);
    expect(result.modelFiltered).toEqual(["b", "c"]);
  });

  it("returns everything when nothing is excluded", () => {
    const result = selectCandidates({ shadows: [{ ...base, id: "x" }], activeShadowIds: new Set(), mainModelId: "m/1" });
    expect(result.candidates.map((s) => s.id)).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/scheduler.test.ts`
Expected: FAIL（`selectCandidates` 未定义）

- [ ] **Step 3: Implement**

`src/scheduler.ts` 追加：

```ts
export function selectCandidates(options: {
  shadows: readonly ShadowDefinition[];
  activeShadowIds: ReadonlySet<string>;
  mainModelId: string;
}): { candidates: ShadowDefinition[]; modelFiltered: string[]; runningExcluded: string[] } {
  const modelFiltered: string[] = [];
  const runningExcluded: string[] = [];
  const candidates = options.shadows.filter((shadow) => {
    if (!shadow.enabled) {
      modelFiltered.push(shadow.id);
      return false;
    }
    if (options.activeShadowIds.has(shadow.id)) {
      runningExcluded.push(shadow.id);
      return false;
    }
    if (!matchesModel(shadow, options.mainModelId)) {
      modelFiltered.push(shadow.id);
      return false;
    }
    return true;
  });
  return { candidates, modelFiltered, runningExcluded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts test/scheduler.test.ts
git commit -m "feat: add deterministic gatekeeper candidate prefilter"
```

---

### Task 4: runtime 接线（预筛→门卫→launch），删除随机调度

**Files:**
- Modify: `src/runtime.ts`
- Modify: `src/scheduler.ts`（删除 `decideHeartbeat`、`sample`）
- Modify: `src/types.ts`（删除 `HeartbeatDecision`）
- Delete: `test/random.test.ts` 的引用暂留到 Task 5；本 task 只改 runtime/scheduler 相关测试
- Test: `test/runtime.test.ts`、`test/scheduler.test.ts`、`test/tools.test.ts`（如引用被删符号）

**Interfaces:**
- Consumes: Task 1 `brief`、Task 2 `runGatekeeper`、Task 3 `selectCandidates`。
- Produces: `runHeartbeat` 内部行为（外部无新接口）；runtime 构造可注入 `gatekeeper?: typeof runGatekeeper`（仅测试用，默认真实现）。

- [ ] **Step 1: Write the failing tests**

在 `test/runtime.test.ts` 追加（沿用该文件现有的 fake `pi`/session 装置；以下为新增用例骨架，装置变量名以现有文件为准）：

```ts
it("calls the gatekeeper and launches listed shadows with briefs", async () => {
  // 装置：一个 enabled shadow "a"；turn_end 带工具结果。
  const gatekeeperCalls: any[] = [];
  runtime = createRuntime({ gatekeeper: async (options) => {
    gatekeeperCalls.push(options);
    return { ok: true, activations: [{ id: "a", brief: "check scheduler" }] };
  } });
  await fireTurnEndWithToolResult();
  await settleHeartbeatChain();
  expect(gatekeeperCalls.length).toBe(1);
  expect(gatekeeperCalls[0].candidates.map((s: any) => s.id)).toEqual(["a"]);
  expect(gatekeeperCalls[0].trajectory).toContain("USER");
  // shadow 已启动：active 计数为 1（经 status 或 runner fake 断言，依现有装置）
});

it("skips the gatekeeper when no candidates survive the prefilter", async () => {
  let called = false;
  runtime = createRuntime({ gatekeeper: async () => { called = true; return { ok: true, activations: [] }; } });
  await fireTurnEndWithToolResult(); // 无 shadow 定义
  await settleHeartbeatChain();
  expect(called).toBe(false);
});

it("fails closed on gatekeeper error and records the event", async () => {
  runtime = createRuntime({ gatekeeper: async () => ({ ok: false, activations: [], error: "boom" }) });
  await fireTurnEndWithToolResult(); // 一个 enabled shadow
  await settleHeartbeatChain();
  const events = recentEvents();
  expect(events.some((e: any) => e.kind === "gatekeeper-error" && e.data.error === "boom")).toBe(true);
  expect(events.some((e: any) => e.kind === "run-start")).toBe(false);
});

it("aborts an in-flight gatekeeper call on new user input", async () => {
  let aborted = false;
  runtime = createRuntime({ gatekeeper: (options) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  }) });
  const pending = fireTurnEndWithToolResult();
  await settleHeartbeatChain(); // 让 gatekeeper 进入等待
  fireUserInput();
  await settleHeartbeatChain();
  await pending;
  expect(aborted).toBe(true);
});
```

同时删除 `test/runtime.test.ts` 中针对 `heartbeat` 抽签事件（`heartbeat`/`heartbeat-skipped` 中 roll 字段）的断言，改为断言 `gatekeeper-decision` 事件存在。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/runtime.test.ts`
Expected: FAIL（runtime 尚无 gatekeeper 注入与相关事件）

- [ ] **Step 3: Implement runtime 接线**

`src/runtime.ts`：

1. 构造函数 options 增加 `gatekeeper?: typeof runGatekeeper`，存为 `private readonly gatekeeper: typeof runGatekeeper`（默认 `runGatekeeper`）。
2. 新增字段 `private heartbeatAbort?: AbortController;`；`input` 事件处理器中 `this.heartbeatAbort?.abort();`（在 bump epoch 处）。
3. `runHeartbeat` 中，替换 `decideHeartbeat` 调用块为：

```ts
const availableSlots = Math.max(0, this.configStore.current.maxParallelShadows - this.active.size);
if (availableSlots <= 0) {
  this.record("heartbeat-skipped", { reason: "no-slots", modelCalls: this.modelCalls });
  return;
}
const selection = selectCandidates({
  shadows: snapshot.shadows,
  activeShadowIds: new Set([...this.active.values()].map(({ shadow }) => shadow.id)),
  mainModelId: fullModelId,
});
if (!selection.candidates.length) {
  this.record("heartbeat-skipped", { reason: "no-candidates", modelCalls: this.modelCalls, modelFiltered: selection.modelFiltered });
  return;
}
const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
const trajectory = serializeTrajectory(context.messages as unknown as Record<string, unknown>[]);
const controller = new AbortController();
this.heartbeatAbort = controller;
const outcome = await this.gatekeeper({
  candidates: selection.candidates,
  trajectory,
  config: this.configStore.current,
  mainModel: ctx.model,
  mainThinkingLevel: ctx.thinkingLevel,
  signal: controller.signal,
  deps: {
    resolveModel: (id) => resolveModel(ctx, id),
    modelAuthOk: (model) => ctx.modelRegistry.hasConfiguredAuth(model) || ctx.modelRegistry.isUsingOAuth(model),
  },
});
this.heartbeatAbort = undefined;
if (heartbeatEpoch !== this.heartbeatEpoch) return;
if (!outcome.ok) {
  this.record("gatekeeper-error", { error: outcome.error });
  return;
}
const activated = outcome.activations.slice(0, availableSlots)
  .map((activation) => ({ shadow: snapshot.shadows.find((shadow) => shadow.id === activation.id), brief: activation.brief }))
  .filter((entry): entry is { shadow: ShadowDefinition; brief: string } => Boolean(entry.shadow));
this.record("gatekeeper-decision", {
  activated: activated.map(({ shadow, brief }) => ({ id: shadow.id, brief })),
  candidates: selection.candidates.map((shadow) => shadow.id),
  ...(outcome.truncated ? { truncated: true } : {}),
  ...(selection.modelFiltered.length ? { modelFiltered: selection.modelFiltered } : {}),
});
if (!activated.length) return;
const availableTools = new Set(this.pi.getAllTools().map((tool) => tool.name));
for (const { shadow, brief } of activated) {
  if (this.paused || heartbeatEpoch !== this.heartbeatEpoch) break;
  this.launchShadow(ctx, shadow, ctx.model, fullModelId, context, availableTools, brief);
}
```

4. `launchShadow` 增加末位参数 `brief?: string`，透传 `brief,` 进 `this.runner.run({...})`。
5. 删除 `decideHeartbeat` import、`createRandom` import、`this.random` 字段及 `session_start` 中的 `this.random = ...` 与 `session-config` 事件记录（Task 5 处理 config 字段本身）。
6. `statusLines()`：`heartbeat ...` 段改为 `gatekeeper ${config.gatekeeperModel ?? config.defaultShadowModel ?? "main model"}`；`hasRecentRunErrors()` 扩展为同时匹配 `event.kind === "gatekeeper-error"`；删除不再使用的 `formatNumber`。

`src/scheduler.ts`：删除 `decideHeartbeat` 与 `sample`；`src/types.ts`：删除 `HeartbeatDecision`。同步删除 `test/scheduler.test.ts` 中 `decideHeartbeat` 的 describe 块。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS（`test/random.test.ts` 此时仍引用未删的 `src/random.ts`，应继续通过；若 typecheck 报 runtime 中 `randomSeed` 残留引用，属 Task 5 范围，先保证本 task 无引用）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: replace random heartbeat with gatekeeper dispatch"
```

---

### Task 5: 配置面收缩与废弃字段清理

**Files:**
- Modify: `src/types.ts`（`ShadowConfig` 删 `heartbeatProbability`、`randomSeed`，增 `gatekeeperModel?: string`）
- Modify: `src/config.ts`
- Modify: `src/management-tools.ts`
- Delete: `src/random.ts`、`test/random.test.ts`
- Test: `test/config.test.ts`、`test/management-tools.test.ts`

**Interfaces:**
- Consumes: Task 4 后 runtime 已不引用 `heartbeatProbability`/`randomSeed`。
- Produces: `ShadowConfig.gatekeeperModel?: string`（Task 4 的 statusLines 已引用，本 task 使其编译通过——若 Task 4 已临时用 `as any`，此处移除）。

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts` 追加/改写：

```ts
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
  expect(text).not.toContain('"heartbeat_probability": 0.5,\n    "max_parallel_shadows"');
  const reparsed = parseConfig(JSON.parse(text));
  expect(reparsed.extraFields?.heartbeat_probability).toBe(0.5);
});

it("rejects an invalid gatekeeper_model", () => {
  expect(() => parseConfig({ gatekeeper_model: "   " })).toThrow(/gatekeeper_model/);
});
```

`test/management-tools.test.ts`：断言 `update_shadow_config` 的参数 schema 不再含 `heartbeat_probability`/`random_seed`（按该文件现有断言装置改写），并保留废弃键经 `extraFields` round-trip 的既有用例。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts test/management-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`src/types.ts`：

```ts
export interface ShadowConfig {
  maxParallelShadows: number;
  defaultShadowTimeoutSeconds: number;
  headlessDrainTimeoutSeconds: number;
  resultBatchWindowMs: number;
  defaultShadowModel?: string;
  gatekeeperModel?: string;
  defaultThinkingLevel: ThinkingLevel;
  extraFields?: Record<string, unknown>;
}
```

`src/config.ts`：
- `KNOWN_CONFIG_KEYS` 增加 `"gatekeeper_model"`，删除 `"heartbeat_probability"`、`"random_seed"`（使其自然落入 `extraFields`）。
- `DEFAULT_CONFIG` 删除 `heartbeatProbability`。
- `parseConfig`：删除 `probability`/`randomSeed` 两行及返回值对应字段；新增 `const gatekeeper = optionalNonEmptyString(value.gatekeeper_model, "gatekeeper_model");`，返回值加 `gatekeeperModel: gatekeeper`。
- `serializeConfig`：删除 `heartbeat_probability` 与 `random_seed` 两行；`...(config.gatekeeperModel ? { gatekeeper_model: config.gatekeeperModel } : {})` 加在 `default_shadow_model` 之后。
- 删除 `optionalSeed`、`numberInRange`（若无其他使用者）。

`src/management-tools.ts`：`update_shadow_config` schema 删除 `heartbeat_probability`、`random_seed` 两行；`parseConfig({...})` 调用中删除对应两行（`current.extraFields` 透传已保证旧键存活）。

删除 `src/random.ts`、`test/random.test.ts`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run verify`
Expected: PASS（全量 typecheck + 测试）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: gatekeeper_model config, deprecate random scheduling fields"
```

---

### Task 6: 文档同步与版本提升

**Files:**
- Modify: `DESIGN.md`
- Modify: `README.md`（英文与中文两节）
- Modify: `package.json`（version → `0.2.0`）
- Modify: `package-lock.json`（`npm install` 同步）

**Interfaces:** 无代码接口；行为契约文档必须与实现一致。

- [ ] **Step 1: 更新 DESIGN.md**

调度相关章节（第 2 节核心结构图与 heartbeat 段落、第 4 节字段表、示例 frontmatter、`/shadow status` 描述）改写为门卫语义：
- 核心结构图中 `Heartbeat Scheduler` 段改为 `Gatekeeper`：`按 turn_end 调用轻量模型分派`。
- 字段表：`activation_probability` 标注"废弃：保留解析但忽略"；`config.json` 字段说明删除 `heartbeat_probability`/`random_seed`，新增 `gatekeeper_model`（含回退链）。
- 新增小节说明门卫契约：输入（净化轨迹 + 职责摘要 400 字符）、输出（`{"activations":[{"id","brief"}]}`）、失败语义（fail-closed 跳过本轮）、30s 超时、brief 中性注入与 Shadow 自检优先。

- [ ] **Step 2: 更新 README.md 双语**

"How it works" 段落（英文与中文各一）改写：删除 `1/3` 概率与独立抽签描述，改为"每个合格 turn_end 调用一次轻量门卫模型，由它决定唤醒哪些 Shadow 并附一句焦点提示"。配置示例与 frontmatter 字段表同步（`gatekeeper_model` 新增、概率字段标注 deprecated）。

- [ ] **Step 3: 版本提升与验证**

```bash
npm version minor --no-git-tag-version   # 0.1.14 → 0.2.0
npm install                              # 同步 lockfile
npm run verify
```

Expected: verify 通过。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: gatekeeper scheduling contract; bump version to 0.2.0"
```

---

## Self-Review 记录

- **Spec coverage**：§2 流程/防线（Task 4，含 AbortSignal 止损）、§3 门卫契约（Task 2）、§3.1 保头保尾截断（Task 2 `fitTrajectory`）、§4 配置面（Task 5）、§5 模块落点（Tasks 1-5 一一对应，`management-tools.ts` 在 Task 5）、§6 可观测性（Task 4 事件 + statusLines + 警告标志）、§7 测试策略（各 task Step 1；`test/random.test.ts` 删除在 Task 5）、§8 文档（Task 6）。无缺口。
- **Placeholder scan**：runtime 测试骨架中的装置调用（`createRuntime`/`fireTurnEndWithToolResult` 等）标注"以现有文件装置为准"，属对既有测试装置的引用而非待定设计；其余步骤均含实际代码。
- **Type consistency**：`GatekeeperOutcome`/`GatekeeperActivation`/`selectCandidates` 返回形状在 Task 2/3 定义与 Task 4 消费处一致；`brief?: string` 在 Task 1 定义、Task 4 透传一致。
