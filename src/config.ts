import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { atomicWriteFile } from "./atomic-file.js";
import type { ShadowConfig } from "./types.js";
import { cleanStringArray, isFiniteNumber, isNonEmptyString, isThinkingLevel } from "./validation.js";

/**
 * Extensions that record or archive whole sessions turn every Shadow run into a
 * separate user-facing record, so they are excluded by default. Set
 * `excluded_extensions` to `[]` to load everything the main session loads.
 */
const DEFAULT_EXCLUDED_EXTENSIONS = ["pi-experiencev2"];

const KNOWN_CONFIG_KEYS = new Set([
  "max_parallel_shadows",
  "default_shadow_timeout_seconds",
  "headless_drain_timeout_seconds",
  "result_batch_window_ms",
  "heartbeat_tools",
  "excluded_extensions",
  "default_shadow_model",
  "gatekeeper_model",
  "default_thinking_level",
]);

export const DEFAULT_CONFIG: ShadowConfig = {
  heartbeatTools: [],
  maxParallelShadows: 2,
  defaultShadowTimeoutSeconds: 300,
  headlessDrainTimeoutSeconds: 120,
  resultBatchWindowMs: 400,
  excludedExtensions: DEFAULT_EXCLUDED_EXTENSIONS,
  defaultThinkingLevel: "low",
};

export function parseConfig(input: unknown): ShadowConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("config must be a JSON object");
  }
  const value = input as Record<string, unknown>;
  const heartbeatTools = cleanStringArray(value.heartbeat_tools, DEFAULT_CONFIG.heartbeatTools, "heartbeat_tools");
  const parallel = positiveInteger(value.max_parallel_shadows, DEFAULT_CONFIG.maxParallelShadows, "max_parallel_shadows");
  const timeout = positiveNumber(value.default_shadow_timeout_seconds, DEFAULT_CONFIG.defaultShadowTimeoutSeconds, "default_shadow_timeout_seconds");
  const drainTimeout = positiveNumber(value.headless_drain_timeout_seconds, DEFAULT_CONFIG.headlessDrainTimeoutSeconds, "headless_drain_timeout_seconds");
  const windowMs = nonNegativeInteger(value.result_batch_window_ms, DEFAULT_CONFIG.resultBatchWindowMs, "result_batch_window_ms");
  const excludedExtensions = cleanStringArray(value.excluded_extensions, DEFAULT_CONFIG.excludedExtensions, "excluded_extensions");
  const model = optionalNonEmptyString(value.default_shadow_model, "default_shadow_model");
  const gatekeeper = optionalNonEmptyString(value.gatekeeper_model, "gatekeeper_model");
  const thinking = value.default_thinking_level ?? DEFAULT_CONFIG.defaultThinkingLevel;
  if (!isThinkingLevel(thinking)) {
    throw new Error("default_thinking_level is invalid");
  }
  // Null prototype: a plain object would route a `__proto__` key through the
  // inherited setter and silently drop it from the serialized config.
  const extraFields: Record<string, unknown> = Object.create(null);
  for (const [key, val] of Object.entries(value)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) extraFields[key] = val;
  }
  return {
    heartbeatTools,
    maxParallelShadows: parallel,
    defaultShadowTimeoutSeconds: timeout,
    headlessDrainTimeoutSeconds: drainTimeout,
    resultBatchWindowMs: windowMs,
    excludedExtensions,
    defaultShadowModel: model,
    gatekeeperModel: gatekeeper,
    defaultThinkingLevel: thinking as ThinkingLevel,
    ...(Object.keys(extraFields).length ? { extraFields } : {}),
  };
}

export function serializeConfig(config: ShadowConfig): string {
  return `${JSON.stringify({
    ...(config.heartbeatTools && config.heartbeatTools.length ? { heartbeat_tools: config.heartbeatTools } : {}),
    max_parallel_shadows: config.maxParallelShadows,
    default_shadow_timeout_seconds: config.defaultShadowTimeoutSeconds,
    headless_drain_timeout_seconds: config.headlessDrainTimeoutSeconds,
    result_batch_window_ms: config.resultBatchWindowMs,
    // Always written, including `[]`: omitting it would silently restore the default.
    excluded_extensions: config.excludedExtensions,
    ...(config.defaultShadowModel ? { default_shadow_model: config.defaultShadowModel } : {}),
    ...(config.gatekeeperModel ? { gatekeeper_model: config.gatekeeperModel } : {}),
    default_thinking_level: config.defaultThinkingLevel,
    ...(config.extraFields ?? {}),
  }, null, 2)}\n`;
}

export class ConfigStore {
  readonly configPath: string;
  private lastGood = DEFAULT_CONFIG;
  private lastError?: string;

  constructor(private readonly agentDir: string) {
    this.configPath = join(agentDir, "shadow-minds", "config.json");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    try {
      await readFile(this.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWriteFile(this.configPath, serializeConfig(DEFAULT_CONFIG), { overwrite: true });
    }
    await this.reload();
  }

  async reload(): Promise<{ config: ShadowConfig; error?: string }> {
    try {
      const raw = await readFile(this.configPath, "utf8");
      this.lastGood = parseConfig(JSON.parse(raw));
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return { config: this.lastGood, error: this.lastError };
  }

  get current(): ShadowConfig {
    return this.lastGood;
  }

  get error(): string | undefined {
    return this.lastError;
  }
}

function positiveNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!isFiniteNumber(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  const parsed = positiveNumber(value, fallback, name);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function nonNegativeInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
