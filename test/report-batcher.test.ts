import { describe, expect, it, vi } from "vitest";
import { ReportBatcher } from "../src/report-batcher.js";
import type { ShadowReport } from "../src/types.js";

function report(content: string, runId: string): ShadowReport {
  return { shadowId: content, shadowName: content, content, epoch: 1, runId };
}

describe("ReportBatcher", () => {
  it("combines reports inside the window", async () => {
    vi.useFakeTimers();
    const delivered: string[][] = [];
    const batcher = new ReportBatcher(400, (reports) => { delivered.push(reports.map(({ content }) => content)); });
    batcher.add({ shadowId: "a", shadowName: "A", content: "one", epoch: 1, runId: "1" });
    batcher.add({ shadowId: "b", shadowName: "B", content: "two", epoch: 1, runId: "2" });
    expect(batcher.hasPending).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(delivered).toEqual([["one", "two"]]);
    expect(batcher.hasPending).toBe(false);
    vi.useRealTimers();
  });

  it("contains a rejecting delivery in the timer path and keeps serving", async () => {
    vi.useFakeTimers();
    let fail = true;
    const seen: string[][] = [];
    const batcher = new ReportBatcher(100, (reports) => {
      seen.push(reports.map(({ content }) => content));
      return fail ? Promise.reject(new Error("deliver failed")) : Promise.resolve();
    });
    batcher.add(report("one", "1"));
    // The fire-and-forget timer must swallow the rejection, not leak it.
    await vi.advanceTimersByTimeAsync(100);
    fail = false;
    batcher.add(report("two", "2"));
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([["one"], ["two"]]);
    vi.useRealTimers();
  });

  it("flush() rejections propagate to the caller but do not poison the queue", async () => {
    vi.useFakeTimers();
    let fail = true;
    const seen: string[][] = [];
    const batcher = new ReportBatcher(100, (reports) => {
      seen.push(reports.map(({ content }) => content));
      return fail ? Promise.reject(new Error("deliver failed")) : Promise.resolve();
    });
    batcher.add(report("one", "1"));
    await expect(batcher.flush()).rejects.toThrow("deliver failed");
    fail = false;
    batcher.add(report("two", "2"));
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([["one"], ["two"]]);
    vi.useRealTimers();
  });

  it("serializes overlapping deliveries one at a time", async () => {
    const order: string[] = [];
    let releaseFirst: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const batcher = new ReportBatcher(1000, async (reports) => {
      const names = reports.map(({ content }) => content).join(",");
      order.push(`start ${names}`);
      if (names === "one") await gate;
      order.push(`end ${names}`);
    });
    batcher.add(report("one", "1"));
    const first = batcher.flush();
    await new Promise((r) => setTimeout(r, 0)); // first delivery started and is blocked on the gate
    batcher.add(report("two", "2"));
    const second = batcher.flush(); // must wait for the first to finish
    order.push("queued second");
    releaseFirst!();
    await Promise.all([first, second]);
    expect(order).toEqual(["start one", "queued second", "end one", "start two", "end two"]);
    batcher.clear();
  });

  it("a queued flush does not cancel a newer report's batching window", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const batcher = new ReportBatcher(50, async (reports) => {
      order.push(reports.map(({ content }) => content).join(","));
      if (reports[0]!.content === "one") await gate;
    });
    batcher.add(report("one", "1"));
    const first = batcher.flush(); // in-flight delivery of [one], blocked on the gate
    await new Promise((resolve) => setTimeout(resolve, 5));
    batcher.add(report("two", "2")); // starts window T2
    const second = batcher.flush(); // queued; snapshots [two], clears T2 at enqueue time
    batcher.add(report("three", "3")); // starts its own fresh window T3
    releaseFirst!();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 120)); // T3 fires undisturbed
    expect(order).toEqual(["one", "two", "three"]); // old behavior: ["one", "two,three"]
  });

  it("clear() drops pending reports and returns the dropped count", async () => {
    const batcher = new ReportBatcher(100, () => {});
    expect(batcher.clear()).toBe(0);
    batcher.add(report("one", "1"));
    batcher.add(report("two", "2"));
    expect(batcher.clear()).toBe(2);
    expect(batcher.hasPending).toBe(false);
  });

  it("hasPending reflects an in-flight delivery", async () => {
    let release: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const batcher = new ReportBatcher(100, async () => { await gate; });
    batcher.add(report("one", "1"));
    const pending = batcher.flush();
    expect(batcher.hasPending).toBe(true);
    release!();
    await pending;
    expect(batcher.hasPending).toBe(false);
  });
});
