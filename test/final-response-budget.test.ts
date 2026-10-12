import { describe, expect, it } from "vitest";
import { FinalResponseBudget } from "../src/final-response-budget.js";
import type { ShadowDefinition } from "../src/types.js";

describe("FinalResponseBudget", () => {
  it("treats omitted and zero limits as unlimited", () => {
    const budget = new FinalResponseBudget();
    const omitted = shadow("omitted");
    const zero = shadow("zero", 0);

    budget.commit(["omitted", "zero", "omitted", "zero", "zero"]);

    expect(budget.canRun(omitted)).toBe(true);
    expect(budget.canRun(zero)).toBe(true);
  });

  it("tracks usage per Shadow and blocks runs at the limit", () => {
    const budget = new FinalResponseBudget();
    const limited = shadow("limited", 2);
    const other = shadow("other", 1);

    expect(budget.canRun(limited)).toBe(true);
    budget.commit(["limited", "other"]);
    expect(budget.canRun(limited)).toBe(true);
    expect(budget.canRun(other)).toBe(false);

    budget.commit(["limited"]);
    expect(budget.canRun(limited)).toBe(false);
    expect(budget.used("limited")).toBe(2);
    expect(budget.used("other")).toBe(1);
    expect(budget.used("unseen")).toBe(0);
  });

  it("resets all usage at a user-task boundary", () => {
    const budget = new FinalResponseBudget();
    const limited = shadow("limited", 1);

    budget.commit(["limited"]);
    expect(budget.canRun(limited)).toBe(false);

    budget.reset();
    expect(budget.canRun(limited)).toBe(true);
    expect(budget.used("limited")).toBe(0);
  });
});

function shadow(id: string, finalResponseRounds?: number): ShadowDefinition {
  return {
    id,
    name: id,
    enabled: true,
    debug: false,
    trigger: ["final_response"],
    activeForModels: ["*"],
    ...(finalResponseRounds === undefined ? {} : { finalResponseRounds }),
    tools: [],
    activationTools: [],
    prompt: id,
    filePath: `${id}.md`,
  };
}
