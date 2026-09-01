import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageStore } from "../src/usage-store.js";
import { zeroUsage, type ShadowUsage } from "../src/usage.js";

type UsageOverrides = Omit<Partial<ShadowUsage>, "cost"> & { cost?: Partial<ShadowUsage["cost"]> };

function usage(overrides: UsageOverrides = {}): ShadowUsage {
  const base = zeroUsage();
  return {
    ...base,
    ...overrides,
    cost: { ...base.cost, ...overrides.cost },
  };
}

describe("UsageStore", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "shadow-usage-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("starts missing lifetime data at zero", async () => {
    const store = new UsageStore(agentDir);
    await store.initialize();

    expect(store.current).toEqual(zeroUsage());
    expect(store.error).toBeUndefined();
  });

  it("loads a valid versioned lifetime document", async () => {
    const lifetime = usage({ requests: 3, input: 42, totalTokens: 42, cost: { input: 0.12, total: 0.12 } });
    const path = join(agentDir, "shadow-minds", "usage.json");
    await mkdir(join(agentDir, "shadow-minds"), { recursive: true });
    await writeFile(path, `${JSON.stringify({ version: 1, lifetime })}\n`, "utf8");

    const store = new UsageStore(agentDir);
    await store.initialize();

    expect(store.current).toEqual(lifetime);
    expect(store.error).toBeUndefined();
  });

  it("reports invalid or unsupported lifetime data and starts a new in-memory aggregate", async () => {
    const path = join(agentDir, "shadow-minds", "usage.json");
    await mkdir(join(agentDir, "shadow-minds"), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 2, lifetime: {} }), "utf8");

    const store = new UsageStore(agentDir);
    await store.initialize();

    expect(store.current).toEqual(zeroUsage());
    expect(store.error).toMatch(/unsupported/);
  });

  it("replaces an unparsable lifetime document with the next successful write", async () => {
    const path = join(agentDir, "shadow-minds", "usage.json");
    await mkdir(join(agentDir, "shadow-minds"), { recursive: true });
    await writeFile(path, "{not json at all");

    const store = new UsageStore(agentDir);
    await store.initialize();
    expect(store.error).toMatch(/not valid JSON|unsupported/);

    const added = usage({ requests: 1, input: 20, totalTokens: 20, cost: { input: 0.2, total: 0.2 } });
    await store.add(added);
    await store.flush();

    expect(store.error).toBeUndefined();
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.lifetime).toEqual(added);

    const reloaded = new UsageStore(agentDir);
    await reloaded.initialize();
    expect(reloaded.current).toEqual(added);
    expect(reloaded.error).toBeUndefined();
  });

  it("persists lifetime data for a new store instance", async () => {
    const initial = new UsageStore(agentDir);
    await initial.initialize();
    await initial.add(usage({ requests: 1, input: 12, output: 3, totalTokens: 15, cost: { input: 0.1, output: 0.02, total: 0.12 } }));
    await initial.flush();

    const reloaded = new UsageStore(agentDir);
    await reloaded.initialize();

    expect(reloaded.current).toEqual(usage({ requests: 1, input: 12, output: 3, totalTokens: 15, cost: { input: 0.1, output: 0.02, total: 0.12 } }));
  });

  it("retries retained usage when flush follows a recoverable write failure", async () => {
    const store = new UsageStore(agentDir);
    await store.initialize();
    await mkdir(store.usagePath, { recursive: true });

    const delta = usage({ requests: 1, input: 12, totalTokens: 12, cost: { input: 0.1, total: 0.1 } });
    await store.add(delta);
    expect(store.error).toBeDefined();
    expect(store.current).toEqual(delta);

    await rm(store.usagePath, { recursive: true });
    await store.flush();

    expect(store.error).toBeUndefined();
    const persisted = JSON.parse(await readFile(store.usagePath, "utf8"));
    expect(persisted.lifetime).toEqual(delta);
  });

  it("serializes concurrent additions without losing any aggregate", async () => {
    const store = new UsageStore(agentDir);
    await store.initialize();
    const additions = [
      usage({ requests: 1, input: 10, totalTokens: 10, cost: { input: 0.1, total: 0.1 } }),
      usage({ requests: 1, output: 20, totalTokens: 20, cost: { output: 0.2, total: 0.2 } }),
      usage({ requests: 1, cacheRead: 30, cacheWrite: 40, totalTokens: 70, cost: { cacheRead: 0.3, cacheWrite: 0.4, total: 0.7 } }),
    ];

    await Promise.all(additions.map((entry) => store.add(entry)));
    await store.flush();

    const persisted = JSON.parse(await readFile(store.usagePath, "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.lifetime).toEqual(usage({
      requests: 3,
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
    }));
  });

  it("merges concurrent additions from separate stores through the shared usage file", async () => {
    const first = new UsageStore(agentDir);
    const second = new UsageStore(agentDir);
    await Promise.all([first.initialize(), second.initialize()]);

    await Promise.all([
      first.add(usage({ requests: 1, input: 10, totalTokens: 10, cost: { input: 0.1, total: 0.1 } })),
      second.add(usage({ requests: 2, output: 20, totalTokens: 20, cost: { output: 0.2, total: 0.2 } })),
    ]);
    await Promise.all([first.flush(), second.flush()]);

    const reloaded = new UsageStore(agentDir);
    await reloaded.initialize();

    const combined = usage({
      requests: 3,
      input: 10,
      output: 20,
      totalTokens: 30,
      cost: { input: 0.1, output: 0.2, total: 0.1 + 0.2 },
    });
    expect([first.current, second.current]).toContainEqual(combined);
    expect(reloaded.current).toEqual(combined);
  });

  it("merges simultaneous additions from separate Node processes", async () => {
    // Costs 0.25/0.5/0.75/1 are exact binary fractions, so the aggregate is
    // 2.5 regardless of the order the writers flush in (0.1+0.2+0.3+0.4 is not).
    const writerInputs = [25, 50, 75, 100];
    const writers = writerInputs.map((input, index) => spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"),
        join(process.cwd(), "test", "fixtures", "usage-writer.ts"),
        agentDir,
        String(index),
        String(input),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ));

    await waitUntil(() => writerInputs.every((_, index) => existsSync(join(agentDir, `ready-${index}`))));
    await writeFile(join(agentDir, "start"), "", "utf8");
    await Promise.all(writers.map(waitForChild));

    const reloaded = new UsageStore(agentDir);
    await reloaded.initialize();
    expect(reloaded.current).toEqual(usage({
      requests: 4,
      input: 250,
      totalTokens: 250,
      cost: { input: 2.5, total: 2.5 },
    }));
    // vite-node child spawns are starved when the whole suite runs in parallel.
  }, 60_000);
});

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("usage writers did not become ready");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`usage writer exited ${code}: ${stderr}`));
    });
  });
}
