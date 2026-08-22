import { contentText } from "@earendil-works/pi-ai";
import type { ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolveRunThinkingLevel, type ShadowRunRequest } from "./shadow-runner.js";
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

export interface GatekeeperActivation {
  id: string;
  brief: string;
}

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
    const resolved = deps.resolveModel(explicitId);
    if (!resolved) return fail(`gatekeeper model not found: ${explicitId}`);
    model = resolved;
  }
  if (deps.modelAuthOk && !deps.modelAuthOk(model)) {
    return fail(`gatekeeper model ${model.provider}/${model.id} has no configured auth`);
  }
  let thinkingLevel: ThinkingLevel | undefined;
  try {
    // resolveRunThinkingLevel only reads shadow.thinkingLevel, config and
    // mainThinkingLevel; the rest of ShadowRunRequest is irrelevant here.
    const request = {
      shadow: { thinkingLevel: undefined },
      config: options.config,
      mainThinkingLevel: options.mainThinkingLevel,
    } as unknown as ShadowRunRequest;
    thinkingLevel = resolveRunThinkingLevel(model, request);
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
    // pi-agent-core's ThinkingLevel adds "off", which pi-ai's reasoning option
    // does not accept; "off" maps to no reasoning request.
    const reasoning = thinkingLevel === "off" ? undefined : (thinkingLevel as AiThinkingLevel);
    message = await deps.complete(
      model,
      { systemPrompt, messages: [{ role: "user", content: userMessage, timestamp: Date.now() }] },
      { signal: AbortSignal.any(signals), reasoning },
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
