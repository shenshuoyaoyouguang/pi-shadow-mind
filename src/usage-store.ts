import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireUsageFileLock } from "./usage-file-lock.js";
import { addUsage, zeroUsage, type ShadowUsage } from "./usage.js";
import { isFiniteNumber } from "./validation.js";

interface UsageDocument {
  version: 1;
  lifetime: ShadowUsage;
}

const USAGE_DOCUMENT_VERSION = 1;

/** Stores global lifetime usage separately from editable Shadow configuration. */
export class UsageStore {
  readonly usagePath: string;
  private lifetime = zeroUsage();
  private pendingUsage = zeroUsage();
  private lastError?: string;
  private initialization?: Promise<void>;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(agentDir: string) {
    this.usagePath = join(agentDir, "shadow-minds", "usage.json");
  }

  initialize(): Promise<void> {
    this.initialization ??= this.load();
    return this.initialization;
  }

  get current(): ShadowUsage {
    return {
      ...this.lifetime,
      cost: { ...this.lifetime.cost },
    };
  }

  get error(): string | undefined {
    return this.lastError;
  }

  add(usage: ShadowUsage): Promise<void> {
    this.lifetime = addUsage(this.lifetime, usage);
    this.pendingUsage = addUsage(this.pendingUsage, usage);
    return this.enqueueWrite();
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
    if (!isZeroUsage(this.pendingUsage)) await this.enqueueWrite();
  }

  private enqueueWrite(): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(
      () => this.writePending(),
      () => this.writePending(),
    ).then(
      () => {
        this.lastError = undefined;
      },
      (error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      },
    );
    return this.pendingWrite;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.usagePath, "utf8");
      this.lifetime = parseUsageDocumentText(raw).lifetime;
      this.lastError = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.lifetime = zeroUsage();
        this.lastError = undefined;
        return;
      }
      this.lifetime = zeroUsage();
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async writePending(): Promise<void> {
    const delta = this.pendingUsage;
    if (isZeroUsage(delta)) return;
    await mkdir(dirname(this.usagePath), { recursive: true });
    const releaseLock = await acquireUsageFileLock(this.usagePath);
    try {
      const committed = addUsage(await this.readCommittedLifetime(), delta);
      await writeUsageDocument(this.usagePath, committed);
      this.pendingUsage = subtractUsage(this.pendingUsage, delta);
      this.lifetime = addUsage(committed, this.pendingUsage);
    } finally {
      await releaseLock();
    }
  }

  /**
   * Read the on-disk lifetime for a write. A file that exists but cannot be
   * parsed (corrupt JSON, unsupported version) is treated as an empty
   * aggregate so this write overwrites it — matching load()'s "start a new
   * in-memory aggregate" contract; the unparsable content carries no usable
   * data to lose, and lastError clears once the write succeeds. Read errors
   * beyond parsing still propagate — the file may be transiently unreadable
   * and retryable rather than safe to overwrite.
   */
  private async readCommittedLifetime(): Promise<ShadowUsage> {
    let raw: string;
    try {
      raw = await readFile(this.usagePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return zeroUsage();
      throw error;
    }
    try {
      return parseUsageDocumentText(raw).lifetime;
    } catch (error) {
      if (error instanceof UsageDocumentError) return zeroUsage();
      throw error;
    }
  }
}

function subtractUsage(left: ShadowUsage, right: ShadowUsage): ShadowUsage {
  return {
    requests: left.requests - right.requests,
    input: left.input - right.input,
    output: left.output - right.output,
    cacheRead: left.cacheRead - right.cacheRead,
    cacheWrite: left.cacheWrite - right.cacheWrite,
    totalTokens: left.totalTokens - right.totalTokens,
    cost: {
      input: left.cost.input - right.cost.input,
      output: left.cost.output - right.cost.output,
      cacheRead: left.cost.cacheRead - right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite - right.cost.cacheWrite,
      total: left.cost.total - right.cost.total,
    },
  };
}

function isZeroUsage(usage: ShadowUsage): boolean {
  return usage.requests === 0
    && usage.input === 0
    && usage.output === 0
    && usage.cacheRead === 0
    && usage.cacheWrite === 0
    && usage.totalTokens === 0
    && usage.cost.input === 0
    && usage.cost.output === 0
    && usage.cost.cacheRead === 0
    && usage.cost.cacheWrite === 0
    && usage.cost.total === 0;
}

async function writeUsageDocument(usagePath: string, lifetime: ShadowUsage): Promise<void> {
  const temporaryPath = `${usagePath}.${randomUUID()}.tmp`;
  try {
    const document: UsageDocument = { version: USAGE_DOCUMENT_VERSION, lifetime };
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporaryPath, usagePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Distinguishes unparsable document content (recoverable) from IO failures. */
export class UsageDocumentError extends Error {}

function parseUsageDocument(input: unknown): UsageDocument {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new UsageDocumentError("usage must be a JSON object");
  }
  const value = input as { version?: unknown; lifetime?: unknown };
  if (value.version !== USAGE_DOCUMENT_VERSION) throw new UsageDocumentError("usage version is unsupported");
  return { version: USAGE_DOCUMENT_VERSION, lifetime: parseUsage(value.lifetime, "lifetime") };
}

/** Parse a raw file body; load() and the write path share this error surface. */
function parseUsageDocumentText(raw: string): UsageDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageDocumentError("usage is not valid JSON");
  }
  return parseUsageDocument(parsed);
}

function parseUsage(input: unknown, name: string): ShadowUsage {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new UsageDocumentError(`${name} must be an object`);
  }
  const value = input as {
    requests?: unknown;
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
    cost?: unknown;
  };
  const cost = value.cost;
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) {
    throw new UsageDocumentError(`${name}.cost must be an object`);
  }
  const costValue = cost as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    total?: unknown;
  };
  return {
    requests: nonNegativeInteger(value.requests, `${name}.requests`),
    input: nonNegativeNumber(value.input, `${name}.input`),
    output: nonNegativeNumber(value.output, `${name}.output`),
    cacheRead: nonNegativeNumber(value.cacheRead, `${name}.cacheRead`),
    cacheWrite: nonNegativeNumber(value.cacheWrite, `${name}.cacheWrite`),
    totalTokens: nonNegativeNumber(value.totalTokens, `${name}.totalTokens`),
    cost: {
      input: nonNegativeNumber(costValue.input, `${name}.cost.input`),
      output: nonNegativeNumber(costValue.output, `${name}.cost.output`),
      cacheRead: nonNegativeNumber(costValue.cacheRead, `${name}.cost.cacheRead`),
      cacheWrite: nonNegativeNumber(costValue.cacheWrite, `${name}.cost.cacheWrite`),
      total: nonNegativeNumber(costValue.total, `${name}.cost.total`),
    },
  };
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (!isFiniteNumber(value) || value < 0) {
    throw new UsageDocumentError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const number = nonNegativeNumber(value, name);
  if (!Number.isSafeInteger(number)) throw new UsageDocumentError(`${name} must be a non-negative safe integer`);
  return number;
}
