import { lstat, mkdir, readdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ShadowRegistry, parseShadowMarkdown } from "../src/registry.js";
import { EntityStore, serializeShadow } from "../src/entity-store.js";

// Track fs.promises.link so a test can simulate Windows without
// SeCreateSymbolicLinkPrivilege (link fails with EPERM for non-elevated users).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn((...args: Parameters<typeof actual.link>) => actual.link(...args)) };
});

async function makeAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-shadow-mind-entity-"));
}

// Windows requires developer mode or elevation to create symlinks; skip the
// symlink-specific tests when the privilege is unavailable.
async function canCreateSymlink(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "pi-shadow-mind-symlink-"));
  try {
    await symlink(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const symlinkSupported = await canCreateSymlink();

describe("EntityStore persistence integrity", () => {
  it("#10 atomic write: create/update/writeConfig leave valid file and no tmp remnants", async () => {
    const agentDir = await makeAgentDir();
    try {
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, join(agentDir, "shadow-minds", "config.json"));
      await registry.initialize();
      const created = await store.create({ id: "a1", prompt: "Prompt A" });
      expect(created.id).toBe("a1");
      const dir = registry.directory;
      const files = await readdir(dir);
      expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
      const content = await readFile(join(dir, "a1.md"), "utf8");
      expect(content).toContain("Prompt A");
      const updated = await store.update("a1", { prompt: "Prompt A updated" });
      expect(updated.prompt).toBe("Prompt A updated");
      const files2 = await readdir(dir);
      expect(files2.filter((f) => f.includes(".tmp"))).toEqual([]);
      const content2 = await readFile(join(dir, "a1.md"), "utf8");
      expect(content2).toContain("Prompt A updated");
      await store.writeConfig({ maxParallelShadows: 2, defaultShadowTimeoutSeconds: 300, headlessDrainTimeoutSeconds: 120, resultBatchWindowMs: 400, defaultThinkingLevel: "low" });
      const cfg = await readFile(join(dir, "config.json"), "utf8");
      expect(cfg).toContain("max_parallel_shadows");
      const files3 = await readdir(dir);
      expect(files3.filter((f) => f.includes(".tmp"))).toEqual([]);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("#11 unknown frontmatter fields survive update via extraFields preservation", async () => {
    const agentDir = await makeAgentDir();
    try {
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, join(agentDir, "shadow-minds", "config.json"));
      await registry.initialize();
      const filePath = join(registry.directory, "custom.md");
      const src = `---\nid: custom\ncustom_key: preserved-value\nanother: 123\n---\n\nMy prompt body\n`;
      await writeFile(filePath, src, "utf8");
      const loaded = await registry.load();
      const found = loaded.shadows.find((s) => s.id === "custom");
      expect(found).toBeDefined();
      expect(found!.extraFields).toMatchObject({ custom_key: "preserved-value", another: 123 });
      const after = await store.update("custom", { name: "New Name" });
      expect(after.extraFields).toMatchObject({ custom_key: "preserved-value" });
      const raw = await readFile(filePath, "utf8");
      expect(raw).toContain("custom_key");
      expect(raw).toContain("preserved-value");
      expect(raw).toContain("another");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("#13 create duplicate yields clean domain error without absolute path and ensures dir", async () => {
    const agentDir = await makeAgentDir();
    try {
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, join(agentDir, "shadow-minds", "config.json"));
      await store.create({ id: "dup", prompt: "First prompt" });
      await expect(store.create({ id: "dup", prompt: "Second prompt" })).rejects.toThrow(/shadow 'dup' already exists/);
      let caughtError: Error | undefined;
      try {
        await store.create({ id: "dup", prompt: "Second prompt" });
      } catch (e) {
        caughtError = e as Error;
      }
      expect(caughtError).toBeDefined();
      const msg = caughtError!.message;
      expect(msg).not.toMatch(/\//);
      expect(msg).toBe("shadow 'dup' already exists");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("#13 create ensures directory exists even if not yet initialized (ENOENT dir)", async () => {
    const agentDir = await makeAgentDir();
    try {
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, join(agentDir, "shadow-minds", "config.json"));
      const dir = registry.directory;
      await rm(dir, { recursive: true, force: true });
      const created = await store.create({ id: "newdir", prompt: "Hello world prompt" });
      expect(created.id).toBe("newdir");
      const files = await readdir(dir);
      expect(files).toContain("newdir.md");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("#14 delete is idempotent when file already removed externally", async () => {
    const agentDir = await makeAgentDir();
    try {
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, join(agentDir, "shadow-minds", "config.json"));
      await store.create({ id: "del1", prompt: "Prompt for delete test" });
      const shadow = await store.get("del1");
      await unlink(shadow.filePath);
      await expect(store.delete("del1")).resolves.toBeUndefined();
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("#14 update does not resurrect externally deleted file, fails cleanly", async () => {
    const agentDir = await makeAgentDir();
    try {
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, join(agentDir, "shadow-minds", "config.json"));
      await store.create({ id: "res1", prompt: "Original prompt body" });
      const shadow = await store.get("res1");
      await unlink(shadow.filePath);
      await expect(store.update("res1", { prompt: "Should not resurrect" })).rejects.toThrow(/shadow not found/);
      await expect(store.setEnabled("res1", true)).rejects.toThrow(/shadow not found/);
      const { readdir: rd } = await import("node:fs/promises");
      let files: string[] = [];
      try {
        files = await rd(registry.directory);
      } catch {}
      expect(files).not.toContain("res1.md");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("#14 setEnabled after external delete does not resurrect", async () => {
    const agentDir = await makeAgentDir();
    try {
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, join(agentDir, "shadow-minds", "config.json"));
      await store.create({ id: "tog1", prompt: "Toggle prompt" });
      const s = await store.get("tog1");
      await unlink(s.filePath);
      await expect(store.setEnabled("tog1", false)).rejects.toThrow(/shadow not found/);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("create falls back to O_EXCL claim + copy when hardlink is unavailable", async () => {
    const { link } = await import("node:fs/promises");
    const linkMock = link as unknown as { mockRejectedValueOnce: (value: unknown) => void };
    linkMock.mockRejectedValueOnce(Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" }));
    const agentDir = await makeAgentDir();
    try {
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, join(agentDir, "shadow-minds", "config.json"));
      await registry.initialize();
      const created = await store.create({ id: "nolink", prompt: "No hardlink prompt" });
      expect(created.id).toBe("nolink");
      const content = await readFile(join(registry.directory, "nolink.md"), "utf8");
      expect(content).toContain("No hardlink prompt");
      const files = await readdir(registry.directory);
      expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
      // A racing duplicate still surfaces as the domain error, not the raw fs code.
      await expect(store.create({ id: "nolink", prompt: "again" })).rejects.toThrow(/shadow 'nolink' already exists/);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!symlinkSupported)("update preserves symlink-backed shadow files by overwriting the target", async () => {
    const agentDir = await makeAgentDir();
    try {
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, join(agentDir, "shadow-minds", "config.json"));
      await registry.initialize();
      const targetDir = join(agentDir, "shared-shadow-defs");
      await mkdir(targetDir, { recursive: true });
      const targetPath = join(targetDir, "linked-shadow.md");
      const linkPath = join(registry.directory, "linked-shadow.md");
      await writeFile(targetPath, serializeShadow({ id: "linked-shadow", prompt: "Original prompt" }), "utf8");
      await symlink(targetPath, linkPath);

      const updated = await store.update("linked-shadow", { prompt: "Updated prompt" });

      expect(updated.prompt).toBe("Updated prompt");
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(targetPath, "utf8")).toContain("Updated prompt");
      expect(await readFile(linkPath, "utf8")).toContain("Updated prompt");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!symlinkSupported)("writeConfig preserves symlink-backed config files by overwriting the target", async () => {
    const agentDir = await makeAgentDir();
    try {
      const registry = new ShadowRegistry(agentDir);
      const configPath = join(agentDir, "shadow-minds", "config.json");
      const store = new EntityStore(registry, configPath);
      const targetDir = join(agentDir, "shared-shadow-defs");
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(agentDir, "shadow-minds"), { recursive: true });
      const targetPath = join(targetDir, "config.json");
      await writeFile(targetPath, "{}\n", "utf8");
      await symlink(targetPath, configPath);

      await store.writeConfig({ maxParallelShadows: 2, defaultShadowTimeoutSeconds: 300, headlessDrainTimeoutSeconds: 120, resultBatchWindowMs: 400, defaultThinkingLevel: "low" });

      expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(targetPath, "utf8"))).toMatchObject({ max_parallel_shadows: 2 });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("serializeShadow re-emits extraFields verbatim", async () => {
    const src = serializeShadow({ id: "x", prompt: "Hello", extraFields: { my_custom: "value123", num: 42 } } as any);
    expect(src).toContain("my_custom");
    expect(src).toContain("value123");
    const parsed = parseShadowMarkdown(src, "/tmp/x.md");
    expect(parsed.extraFields).toMatchObject({ my_custom: "value123", num: 42 });
  });
});
