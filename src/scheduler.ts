import type {
  ShadowActivationDecision,
  ShadowDefinition,
  ShadowTrigger,
} from "./types.js";

export function extractToolNames(toolResults: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const item of toolResults) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { toolName?: unknown }).toolName;
    if (typeof name === "string" && name.trim().length > 0) {
      names.add(name.trim());
    }
  }
  return names;
}

/**
 * Pure conversation turns do not create useful new evidence for repository-oriented
 * Shadows. Requiring at least one completed Main tool call also prevents a silent
 * Shadow report response from recursively scheduling more Shadows.
 */
export function shouldEvaluateHeartbeat(
  toolsOrResults: readonly unknown[] | ReadonlySet<string>,
  heartbeatTools?: readonly string[],
): boolean {
  const toolNames =
    toolsOrResults instanceof Set
      ? toolsOrResults
      : extractToolNames(toolsOrResults as readonly unknown[]);
  if (toolNames.size === 0) return false;
  if (!heartbeatTools || heartbeatTools.length === 0) return true;
  return heartbeatTools.some((tool) => toolNames.has(tool));
}

export function shouldEvaluateFinalResponse(
  messages: readonly unknown[],
): boolean {
  const message = messages.at(-1);
  if (
    !message ||
    typeof message !== "object" ||
    (message as { role?: unknown }).role !== "assistant"
  )
    return false;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim().length > 0;
  return (
    Array.isArray(content) &&
    content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const value = block as { type?: unknown; text?: unknown };
      return (
        value.type === "text" &&
        typeof value.text === "string" &&
        value.text.trim().length > 0
      );
    })
  );
}

/**
 * Deterministic prefilter for gatekeeper dispatch: enabled, heartbeat-triggered,
 * not already running, active_for_models matches the main model, and activation
 * tools were used. Slot budgeting stays with the caller; disabled, model-mismatched,
 * tool-mismatched and running shadows are reported in separate buckets so heartbeat
 * events stay auditable. The gatekeeper decides among the returned candidates.
 */
export function selectCandidates(options: {
  shadows: readonly ShadowDefinition[];
  activeShadowIds: ReadonlySet<string>;
  mainModelId: string;
  executedTools?: ReadonlySet<string> | readonly string[];
}): { candidates: ShadowDefinition[]; disabled: string[]; modelFiltered: string[]; runningExcluded: string[]; toolFiltered: string[] } {
  const disabled: string[] = [];
  const modelFiltered: string[] = [];
  const runningExcluded: string[] = [];
  const toolFiltered: string[] = [];
  const candidates = options.shadows.filter((shadow) => {
    if (!shadow.enabled) {
      disabled.push(shadow.id);
      return false;
    }
    if (!hasTrigger(shadow, "heartbeat")) return false;
    if (options.activeShadowIds.has(shadow.id)) {
      runningExcluded.push(shadow.id);
      return false;
    }
    if (!matchesModel(shadow, options.mainModelId)) {
      modelFiltered.push(shadow.id);
      return false;
    }
    if (!matchesActivationTools(shadow, options.executedTools)) {
      toolFiltered.push(shadow.id);
      return false;
    }
    return true;
  });
  return { candidates, disabled, modelFiltered, runningExcluded, toolFiltered };
}

export function decideFinalResponse(options: {
  shadows: readonly ShadowDefinition[];
  mainModelId: string;
  canRunFinalResponse?: (shadow: ShadowDefinition) => boolean;
}): ShadowActivationDecision {
  const modelFiltered: string[] = [];
  const roundFiltered: string[] = [];
  const candidates = options.shadows
    .filter((shadow) => {
      if (!shadow.enabled || !hasTrigger(shadow, "final_response")) return false;
      if (!matchesModel(shadow, options.mainModelId)) {
        modelFiltered.push(shadow.id);
        return false;
      }
      if (options.canRunFinalResponse && !options.canRunFinalResponse(shadow)) {
        roundFiltered.push(shadow.id);
        return false;
      }
      return true;
    })
    .map((shadow) => ({ shadow, roll: 0 }));
  return {
    activated: candidates,
    candidates: candidates.map(({ shadow, roll }) => ({
      shadowId: shadow.id,
      roll,
      selected: true,
    })),
    modelFiltered,
    runningExcluded: [],
    roundFiltered,
  };
}

export function matchesModel(shadow: ShadowDefinition, fullModelId: string): boolean {
  if (!shadow.activeForModels || shadow.activeForModels.length === 0) {
    return false;
  }

  const negatives: string[] = [];
  const positives: string[] = [];

  for (const item of shadow.activeForModels) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("!")) {
      const pattern = trimmed.slice(1).trim();
      if (pattern) negatives.push(pattern);
    } else {
      positives.push(trimmed);
    }
  }

  for (const neg of negatives) {
    if (modelPatternMatches(neg, fullModelId)) {
      return false;
    }
  }

  if (positives.length === 0) {
    return negatives.length > 0;
  }

  return positives.some((pos) => modelPatternMatches(pos, fullModelId));
}

function modelPatternMatches(pattern: string, fullModelId: string): boolean {
  if (pattern === "*") return true;
  if (pattern === fullModelId) return true;

  const slashIndex = fullModelId.indexOf("/");
  const modelId = slashIndex !== -1 ? fullModelId.slice(slashIndex + 1) : fullModelId;

  if (!pattern.includes("/") && pattern === modelId) {
    return true;
  }

  if (pattern.includes("*")) {
    const regex = wildcardToRegex(pattern);
    if (regex.test(fullModelId)) return true;
    if (!pattern.includes("/") && regex.test(modelId)) return true;
  }

  return false;
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

export function matchesActivationTools(
  shadow: ShadowDefinition,
  executedTools?: ReadonlySet<string> | readonly string[],
): boolean {
  if (shadow.activationTools.length === 0) {
    return true;
  }
  if (!executedTools) return false;
  const executedSet = executedTools instanceof Set ? executedTools : new Set(executedTools);
  return shadow.activationTools.some((tool) => executedSet.has(tool));
}

function hasTrigger(shadow: ShadowDefinition, trigger: ShadowTrigger): boolean {
  return shadow.trigger.includes(trigger);
}
