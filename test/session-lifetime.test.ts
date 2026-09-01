import { describe, expect, it, vi } from "vitest";
import { SessionLifetime } from "../src/session-lifetime.js";

describe("SessionLifetime", () => {
  it("skips late callbacks after session shutdown", () => {
    const lifetime = new SessionLifetime();
    const action = vi.fn();
    lifetime.activate();
    lifetime.deactivate();

    expect(lifetime.run(action)).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it("contains stale-context errors without deactivating the replacement session", () => {
    const lifetime = new SessionLifetime();
    const laterAction = vi.fn();
    lifetime.activate();

    expect(lifetime.run(() => {
      throw new Error("This extension ctx is stale after session replacement or reload. Do not use it.");
    })).toBe(false);
    expect(lifetime.isActive).toBe(true);
    expect(lifetime.run(laterAction)).toBe(true);
    expect(laterAction).toHaveBeenCalledTimes(1);
  });

  it("does not hide unrelated programming errors", () => {
    const lifetime = new SessionLifetime();
    lifetime.activate();
    expect(() => lifetime.run(() => { throw new Error("boom"); })).toThrow("boom");
  });
});
