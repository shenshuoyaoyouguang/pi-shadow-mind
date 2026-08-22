import type { HeartbeatDecision, ShadowDefinition } from "./types.js";

/**
 * Pure conversation turns do not create useful new evidence for repository-oriented
 * Shadows. Requiring at least one completed Main tool call also prevents a silent
 * Shadow report response from recursively scheduling more Shadows.
 */
export function shouldEvaluateHeartbeat(toolResults: readonly unknown[]): boolean {
  return toolResults.length > 0;
}

export function decideHeartbeat(options: {
  heartbeatProbability: number;
  availableSlots: number;
  shadows: readonly ShadowDefinition[];
  activeShadowIds: ReadonlySet<string>;
  mainModelId: string;
  random?: () => number;
}): HeartbeatDecision {
  const random = options.random ?? Math.random;
  const heartbeatRoll = random();
  if (heartbeatRoll >= options.heartbeatProbability || options.availableSlots <= 0) {
    return { heartbeatRoll, activated: [], candidates: [], modelFiltered: [], runningExcluded: [] };
  }

  const modelFiltered: string[] = [];
  const runningExcluded: string[] = [];
  const rolls = options.shadows
    .filter((shadow) => {
      if (!shadow.enabled) return false;
      if (options.activeShadowIds.has(shadow.id)) {
        runningExcluded.push(shadow.id);
        return false;
      }
      if (!matchesModel(shadow, options.mainModelId)) {
        modelFiltered.push(shadow.id);
        return false;
      }
      return true;
    })
    .map((shadow) => ({ shadow, roll: random() }));
  const hits = rolls.filter(({ shadow, roll }) => roll < shadow.activationProbability);

  const selected = sample(hits, Math.min(options.availableSlots, hits.length), random);
  const selectedIds = new Set(selected.map(({ shadow }) => shadow.id));
  return {
    heartbeatRoll,
    activated: selected,
    candidates: rolls.map(({ shadow, roll }) => ({ shadowId: shadow.id, roll, selected: selectedIds.has(shadow.id) })),
    modelFiltered,
    runningExcluded,
  };
}

export function matchesModel(shadow: ShadowDefinition, fullModelId: string): boolean {
  const patterns = shadow.activeForModels ?? ["*"];
  return patterns.includes("*") || patterns.includes(fullModelId);
}

function sample<T>(values: readonly T[], count: number, random: () => number): T[] {
  if (count >= values.length) return [...values];
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy.slice(0, count);
}
