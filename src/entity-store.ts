import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import { atomicWriteFile } from "./atomic-file.js";
import { serializeConfig } from "./config.js";
import { parseShadowMarkdown, ShadowRegistry } from "./registry.js";
import type { ShadowConfig, ShadowDefinition } from "./types.js";

export type ShadowDraft = Partial<Omit<ShadowDefinition, "filePath">> & { id: string; prompt?: string };

export class EntityStore {
  constructor(readonly registry: ShadowRegistry, private readonly configPath: string) {}

  async list(): Promise<ShadowDefinition[]> {
    return (await this.registry.load()).shadows;
  }

  async get(id: string): Promise<ShadowDefinition> {
    const shadow = (await this.list()).find((candidate) => candidate.id === id);
    if (!shadow) throw new Error(`shadow not found: ${id}`);
    return shadow;
  }

  async create(draft: ShadowDraft): Promise<ShadowDefinition> {
    if ((await this.list()).some((shadow) => shadow.id === draft.id)) throw new Error(`shadow '${draft.id}' already exists`);
    return this.writeParsed(join(this.registry.directory, `${draft.id}.md`), draft, { overwrite: false });
  }

  async update(id: string, patch: Partial<Omit<ShadowDraft, "id">>): Promise<ShadowDefinition> {
    const current = await this.get(id);
    try {
      await stat(current.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`shadow not found: ${id}`);
      }
      throw error;
    }
    const merged: ShadowDraft = { ...current, ...definedOnly(patch), id, prompt: patch.prompt ?? current.prompt };
    if (current.extraFields && !merged.extraFields) merged.extraFields = current.extraFields;
    else if (current.extraFields && merged.extraFields) merged.extraFields = { ...current.extraFields, ...merged.extraFields };
    return this.writeParsed(current.filePath, merged, { overwrite: true });
  }

  private async writeParsed(filePath: string, draft: ShadowDraft, options: { overwrite: boolean }): Promise<ShadowDefinition> {
    const source = serializeShadow({ ...draft, prompt: draft.prompt ?? "Describe this Shadow Mind's responsibility." });
    const parsed = parseShadowMarkdown(source, filePath);
    try {
      await atomicWriteFile(filePath, source, options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`shadow '${draft.id}' already exists`);
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await mkdir(dirname(filePath), { recursive: true });
        try {
          await atomicWriteFile(filePath, source, options);
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(`shadow '${draft.id}' already exists`);
          }
          throw retryError;
        }
      } else {
        throw error;
      }
    }
    return parsed;
  }

  async setEnabled(id: string, enabled: boolean): Promise<ShadowDefinition> {
    return this.update(id, { enabled });
  }

  async delete(id: string): Promise<void> {
    let filePath: string;
    try {
      filePath = (await this.get(id)).filePath;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("shadow not found:")) {
        filePath = join(this.registry.directory, `${id}.md`);
        try {
          await unlink(filePath);
        } catch (inner) {
          if ((inner as NodeJS.ErrnoException).code === "ENOENT") return;
          throw inner;
        }
        return;
      }
      throw error;
    }
    try {
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async readConfig(): Promise<string> {
    return readFile(this.configPath, "utf8");
  }

  async writeConfig(config: ShadowConfig): Promise<void> {
    await atomicWriteFile(this.configPath, serializeConfig(config), { overwrite: true });
  }
}

export function serializeShadow(shadow: ShadowDraft): string {
  const frontmatter: Record<string, unknown> = {
    id: shadow.id,
    ...(shadow.name !== undefined ? { name: shadow.name } : {}),
    enabled: shadow.enabled ?? true,
    debug: shadow.debug ?? false,
    activation_probability: shadow.activationProbability ?? 0.3,
    active_for_models: shadow.activeForModels ?? ["*"],
    ...(shadow.runWithModel ? { run_with_model: shadow.runWithModel } : {}),
    ...(shadow.thinkingLevel ? { thinking_level: shadow.thinkingLevel } : {}),
    ...(shadow.timeoutSeconds !== undefined ? { timeout_seconds: shadow.timeoutSeconds } : {}),
    tools: shadow.tools ?? [],
    ...(shadow.extraFields ?? {}),
  };
  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n\n${(shadow.prompt ?? "").trim()}\n`;
}

export function describeShadow(shadow: ShadowDefinition): string {
  return `${shadow.enabled ? "enabled" : "disabled"} ${shadow.id} (${shadow.name}) p=${shadow.activationProbability} models=${shadow.activeForModels.join(",")} tools=${shadow.tools.join(",") || "default"} file=${basename(shadow.filePath)}`;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
