import type { ShadowDefinition } from "./types.js";

/**
 * Pure conversation turns do not create useful new evidence for repository-oriented
 * Shadows. Requiring at least one completed Main tool call also prevents a silent
 * Shadow report response from recursively scheduling more Shadows.
 */
export function shouldEvaluateHeartbeat(toolResults: readonly unknown[]): boolean {
  return toolResults.length > 0;
}

/**
 * Deterministic prefilter for gatekeeper dispatch: enabled, not already
 * running, active_for_models matches the main model. Slot budgeting stays with
 * the caller; disabled and model-mismatched shadows are reported separately so
 * heartbeat events stay auditable.
 */
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

export function matchesModel(shadow: ShadowDefinition, fullModelId: string): boolean {
  const patterns = shadow.activeForModels ?? ["*"];
  return patterns.includes("*") || patterns.includes(fullModelId);
}
