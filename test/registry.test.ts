import { describe, expect, it } from "vitest";
import { mkdir, symlink, utimes, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { parseShadowMarkdown, ShadowRegistry } from "../src/registry.js";
import { serializeShadow } from "../src/entity-store.js";

// Windows requires developer mode or elevation to create symlinks; skip the
// symlink-specific test when the privilege is unavailable.
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

describe("parseShadowMarkdown", () => {
  it("applies shadow defaults", () => {
    const shadow = parseShadowMarkdown("---\nname: Fact checker\n---\nCheck claims against the project.", "C:/tmp/facts.md");
    expect(shadow).toMatchObject({
      id: "facts",
      name: "Fact checker",
      enabled: true,
      debug: false,
      activationProbability: 0.3,
      activeForModels: ["*"],
      tools: [],
    });
  });

  it("rejects an empty prompt", () => {
    expect(() => parseShadowMarkdown("---\nid: empty\n---\n", "C:/tmp/empty.md")).toThrow(/empty/);
  });

  it("accepts off as a thinking level", () => {
    const shadow = parseShadowMarkdown(
      "---\nid: quick-check\nthinking_level: off\n---\nCheck once and report.",
      "C:/tmp/quick-check.md",
    );
    expect(shadow.thinkingLevel).toBe("off");
  });

  it("#11 preserves unknown frontmatter fields and re-emits them", () => {
    const src = "---\nid: my-shadow\ncustom_field: keep-me\nanother_unknown: 42\n---\n\nPrompt body";
    const parsed = parseShadowMarkdown(src, "/tmp/my-shadow.md");
    expect(parsed.extraFields).toEqual({ custom_field: "keep-me", another_unknown: 42 });
    const re = serializeShadow({ id: parsed.id, prompt: parsed.prompt, extraFields: parsed.extraFields } as any);
    expect(re).toContain("custom_field");
    expect(re).toContain("keep-me");
    const reparsed = parseShadowMarkdown(re, "/tmp/my-shadow.md");
    expect(reparsed.extraFields).toEqual({ custom_field: "keep-me", another_unknown: 42 });
  });
});

describe("ShadowRegistry persistence integrity", () => {
  it.skipIf(!symlinkSupported)("#12 stat ENOENT inside per-file try does not crash load (heartbeat intact)", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-shadow-mind-reg-12-"));
    try {
      const registry = new ShadowRegistry(agentDir);
      await mkdir(registry.directory, { recursive: true });
      await writeFile(join(registry.directory, "a.md"), "---\nid: a\n---\n\nPrompt A", "utf8");
      await symlink(join(registry.directory, "missing-target"), join(registry.directory, "b.md"));
      const snap = await registry.load();
      expect(snap.shadows.some((s) => s.id === "a")).toBe(true);
      expect(snap.shadows.some((s) => s.id === "b")).toBe(false);
      expect(snap.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: join(registry.directory, "b.md") }),
      ]));
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("B20 mtime same-second staleness: size change invalidates cache", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-shadow-mind-reg-b20-"));
    try {
      const registry = new ShadowRegistry(agentDir);
      await mkdir(registry.directory, { recursive: true });
      const fp = join(registry.directory, "x.md");
      await writeFile(fp, "---\nid: x\n---\n\nHello", "utf8");
      const snap1 = await registry.load();
      expect(snap1.shadows.find((s) => s.id === "x")!.prompt).toBe("Hello");
      await writeFile(fp, "---\nid: x\n---\n\nHello world extended content that is longer", "utf8");
      const newSt = await stat(fp);
      const cached: any = (registry as any).cache.get(fp);
      cached.mtimeMs = newSt.mtimeMs;
      const snap2 = await registry.load();
      expect(snap2.shadows.find((s) => s.id === "x")!.prompt).toContain("extended");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
