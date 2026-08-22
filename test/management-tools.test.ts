import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerManagementTools } from "../src/management-tools.js";
import { ConfigStore } from "../src/config.js";
import { EntityStore } from "../src/entity-store.js";
import { ShadowRegistry } from "../src/registry.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

function collectTools(store: any, getConfig: any) {
  const map = new Map<string, ToolDefinition>();
  const pi: any = { registerTool: (t: ToolDefinition) => map.set(t.name, t) };
  registerManagementTools(pi, store, getConfig);
  return map;
}

function mockCtx(confirmReturn = true) {
  return { hasUI: true, ui: { confirm: async () => confirmReturn } } as any;
}

describe("management-tools persistence defects", () => {
  it("#15 create_shadow schema rejects empty prompt at boundary", () => {
    const tools = collectTools({} as any, () => ({} as any));
    const create = tools.get("create_shadow")!;
    expect(create).toBeDefined();
    const schema: any = create.parameters;
    // prompt must have minLength 1 and pattern requiring non-whitespace
    const promptSchema = schema.properties?.prompt;
    expect(promptSchema.minLength).toBe(1);
    expect(promptSchema.pattern).toContain("\\S");
    // Value.Check should fail for empty prompt
    expect(Value.Check(schema, { id: "test", prompt: "" })).toBe(false);
    expect(Value.Check(schema, { id: "test", prompt: "   " })).toBe(false);
    expect(Value.Check(schema, { id: "test", prompt: "valid prompt" })).toBe(true);
  });

  it("#15 update_shadow schema rejects whitespace-only name and run_with_model", () => {
    const tools = collectTools({} as any, () => ({} as any));
    const upd = tools.get("update_shadow")!;
    const schema: any = upd.parameters;
    const nameSchema = schema.properties?.name;
    expect(nameSchema.minLength).toBe(1);
    expect(nameSchema.pattern).toContain("\\S");
    const runSchema = schema.properties?.run_with_model;
    expect(runSchema.minLength).toBe(1);
    expect(Value.Check(schema, { id: "test", name: "" })).toBe(false);
    expect(Value.Check(schema, { id: "test", name: "   " })).toBe(false);
    expect(Value.Check(schema, { id: "test", run_with_model: "   " })).toBe(false);
    expect(Value.Check(schema, { id: "test", name: "Good Name" })).toBe(true);
  });

  it("#13 management tools surface clean domain error without absolute path or stack", async () => {
    const store: any = {
      create: async () => {
        const err: any = new Error("EEXIST: file already exists, open '/tmp/pi-shadow-mind/shadow.md'");
        err.code = "EEXIST";
        throw err;
      },
      list: async () => [],
      update: async () => { throw new Error("/abs/path leaked"); },
      setEnabled: async () => { throw new Error("/abs/path leaked"); },
      delete: async () => { throw new Error("/abs/path leaked"); },
      readConfig: async () => "",
      writeConfig: async () => {},
    };
    const tools = collectTools(store, () => ({ maxParallelShadows: 2, defaultShadowTimeoutSeconds: 300, headlessDrainTimeoutSeconds: 120, resultBatchWindowMs: 400, defaultThinkingLevel: "low" } as any));
    const create = tools.get("create_shadow")!;
    try {
      await create.execute("id1", { id: "myid", prompt: "hello" } as any, undefined, undefined, mockCtx());
      expect.fail("should have thrown");
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain("/tmp");
      expect(msg).not.toContain("/abs");
      expect(msg).not.toContain("at ");
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it("#13 sanitizedError strips absolute paths from store EEXIST", async () => {
    const rawStore: any = {
      create: async () => {
        // Real Node fs EEXIST shape: the absolute path rides in the message.
        throw new Error("EEXIST: file already exists, open '/tmp/pi-shadow-mind-agent/shadow-minds/dup.md'");
      },
      list: async () => [{ id: "dup" }],
      update: async () => { throw new Error("shadow 'dup' already exists"); },
      setEnabled: async () => { throw new Error("shadow 'dup' already exists"); },
      delete: async () => {},
      readConfig: async () => "{}",
      writeConfig: async () => {},
    };
    const tools = collectTools(rawStore, () => ({ maxParallelShadows: 2, defaultShadowTimeoutSeconds: 300, headlessDrainTimeoutSeconds: 120, resultBatchWindowMs: 400, defaultThinkingLevel: "low" } as any));
    const create = tools.get("create_shadow")!;
    try {
      await create.execute("id2", { id: "dup", prompt: "new" } as any, undefined, undefined, mockCtx());
      expect.fail("should have thrown");
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("<path>");
      expect(msg).not.toContain("/tmp/pi-shadow-mind-agent");
      expect(msg).toContain("EEXIST");
    }
  });

  it("sanitizedError redacts UNC paths", async () => {
    const uncStore: any = {
      create: async () => {
        throw new Error("ENOENT: no such file or directory, open '\\\\fileserver\\share\\shadow-minds\\x.md'");
      },
      list: async () => [],
      update: async () => {},
      setEnabled: async () => {},
      delete: async () => {},
      readConfig: async () => "",
      writeConfig: async () => {},
    };
    const tools = collectTools(uncStore, () => ({} as any));
    const create = tools.get("create_shadow")!;
    await expect(create.execute("id", { id: "myid", prompt: "hello" } as any, undefined, undefined, mockCtx())).rejects.toSatisfy((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("<path>");
      expect(msg).not.toContain("fileserver");
      expect(msg).not.toContain("share");
      expect(msg).toContain("ENOENT");
      return true;
    });
  });

  it("sanitizedError redacts quoted POSIX paths that contain spaces", async () => {
    const posixStore: any = {
      create: async () => {
        throw new Error("EEXIST: file already exists, open '/tmp/my shadow dir/dup.md'");
      },
      list: async () => [],
      update: async () => {},
      setEnabled: async () => {},
      delete: async () => {},
      readConfig: async () => "",
      writeConfig: async () => {},
    };
    const tools = collectTools(posixStore, () => ({} as any));
    const create = tools.get("create_shadow")!;
    await expect(create.execute("id", { id: "myid", prompt: "hello" } as any, undefined, undefined, mockCtx())).rejects.toSatisfy((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("<path>");
      expect(msg).not.toContain("my shadow dir");
      expect(msg).not.toContain("dup.md");
      expect(msg).toContain("EEXIST");
      return true;
    });
  });

  it("sanitizedError redacts Windows backslash paths", async () => {
    const winStore: any = {
      create: async () => {
        throw new Error("ENOENT: no such file or directory, open 'C:\\Users\\76578\\.pi\\agent\\shadow-minds\\x.md'\n    at async EntityStore.get");
      },
      list: async () => [],
      update: async () => {},
      setEnabled: async () => {},
      delete: async () => {},
      readConfig: async () => "",
      writeConfig: async () => {},
    };
    const tools = collectTools(winStore, () => ({} as any));
    const create = tools.get("create_shadow")!;
    try {
      await create.execute("id", { id: "myid", prompt: "hello" } as any, undefined, undefined, mockCtx());
      expect.fail("should have thrown");
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain("C:");
      expect(msg).not.toContain("76578");
      expect(msg).not.toContain("at ");
      expect(msg).toContain("<path>");
      expect(msg).toContain("ENOENT");
    }
  });

  it("sanitizedError redacts Windows paths that contain spaces", async () => {
    const winStore: any = {
      create: async () => {
        throw new Error("ENOENT: no such file or directory, open 'C:\\Users\\John Doe\\.pi\\agent\\shadow-minds\\x.md'\n    at async EntityStore.get");
      },
      list: async () => [],
      update: async () => {},
      setEnabled: async () => {},
      delete: async () => {},
      readConfig: async () => "",
      writeConfig: async () => {},
    };
    const tools = collectTools(winStore, () => ({} as any));
    const create = tools.get("create_shadow")!;
    try {
      await create.execute("id", { id: "myid", prompt: "hello" } as any, undefined, undefined, mockCtx());
      expect.fail("should have thrown");
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain("C:");
      expect(msg).not.toContain("John Doe");
      expect(msg).not.toContain("shadow-minds");
      expect(msg).toContain("<path>");
      expect(msg).toContain("ENOENT");
    }
  });

  it("sanitizedError does not mangle non-path slashes or domain messages", async () => {
    const tools = collectTools({ list: async () => [] } as any, () => ({} as any));
    // The update tool re-throws store errors through sanitizedError.
    const upd: any = {
      list: async () => [{ id: "dup" }],
      create: async () => {},
      update: async () => { throw new Error("ratio 1/2 must be in [0,1]"); },
      setEnabled: async () => {},
      delete: async () => {},
      readConfig: async () => "",
      writeConfig: async () => {},
    };
    const update = collectTools(upd, () => ({} as any)).get("update_shadow")!;
    await expect(update.execute("id", { id: "dup", prompt: "x" } as any, undefined, undefined, mockCtx())).rejects.toThrow("ratio 1/2 must be in [0,1]");
    expect(tools.get("list_shadows")).toBeDefined();
  });

  it("#15 update_shadow_config schema drops deprecated scheduling fields", () => {
    const tools = collectTools({} as any, () => ({} as any));
    const cfg = tools.get("update_shadow_config")!;
    const schema: any = cfg.parameters;
    expect(schema.properties.heartbeat_probability).toBeUndefined();
    expect(schema.properties.random_seed).toBeUndefined();
  });

  it("update_shadow_config preserves unknown config keys across the round-trip", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-shadow-mind-mgmt-"));
    try {
      const configStore = new ConfigStore(agentDir);
      await configStore.initialize();
      const configPath = configStore.configPath;
      await writeFile(configPath, `${JSON.stringify({ heartbeat_probability: 0.25, custom_key: "preserved" }, null, 2)}\n`, "utf8");
      const { config: current } = await configStore.reload();
      expect(current.extraFields).toMatchObject({ custom_key: "preserved" });
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, configPath);
      const tools = collectTools(store, () => current);
      const tool = tools.get("update_shadow_config")!;
      await tool.execute("id", { max_parallel_shadows: 3 } as any, undefined, undefined, mockCtx());
      const onDisk = JSON.parse(await readFile(configPath, "utf8"));
      expect(onDisk.max_parallel_shadows).toBe(3);
      expect(onDisk.heartbeat_probability).toBe(0.25);
      expect(onDisk.custom_key).toBe("preserved");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("update_shadow_config clears a model override with an explicit null", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-shadow-mind-mgmt-"));
    try {
      const configStore = new ConfigStore(agentDir);
      await configStore.initialize();
      const configPath = configStore.configPath;
      await writeFile(configPath, `${JSON.stringify({ gatekeeper_model: "test/gk", default_shadow_model: "test/shadow" }, null, 2)}\n`, "utf8");
      const { config: current } = await configStore.reload();
      expect(current.gatekeeperModel).toBe("test/gk");
      const registry = new ShadowRegistry(agentDir);
      const store = new EntityStore(registry, configPath);
      const tools = collectTools(store, () => current);
      const tool = tools.get("update_shadow_config")!;
      expect(Value.Check((tool as any).parameters, { gatekeeper_model: null })).toBe(true);
      await tool.execute("id", { gatekeeper_model: null } as any, undefined, undefined, mockCtx());
      const onDisk = JSON.parse(await readFile(configPath, "utf8"));
      expect(onDisk.gatekeeper_model).toBeUndefined(); // key removed, back to the fallback chain
      expect(onDisk.default_shadow_model).toBe("test/shadow"); // untouched sibling survives
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("registers all 8 expected management tools and shadow commands", () => {
    const tools = collectTools({ list: async () => [] } as any, () => ({} as any));
    const expected = ["list_shadows","create_shadow","update_shadow","enable_shadow","disable_shadow","delete_shadow","get_shadow_config","update_shadow_config"];
    for (const name of expected) expect(tools.has(name), `missing ${name}`).toBe(true);
  });
});
