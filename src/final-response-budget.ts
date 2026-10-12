import type { ShadowDefinition } from "./types.js";

/** The Shadow fields the budget needs to interpret a round limit. */
export type RoundBudgetTarget = Pick<
  ShadowDefinition,
  "id" | "finalResponseRounds"
>;

/**
 * Per-user-task budget for final-response review rounds. Owns the
 * `final_response_rounds` semantics, per-Shadow usage counts, and the reset
 * boundary; Runtime only wires session lifecycle changes and committed rounds.
 */
export class FinalResponseBudget {
  private readonly counts = new Map<string, number>();

  canRun(shadow: RoundBudgetTarget): boolean {
    const limit = shadow.finalResponseRounds ?? 0;
    if (limit <= 0) return true;
    return this.used(shadow.id) < limit;
  }

  commit(shadowIds: readonly string[]): void {
    for (const id of shadowIds) {
      this.counts.set(id, this.used(id) + 1);
    }
  }

  used(shadowId: string): number {
    return this.counts.get(shadowId) ?? 0;
  }

  reset(): void {
    this.counts.clear();
  }
}
