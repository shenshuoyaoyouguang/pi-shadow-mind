/**
 * Typed WASM kernel loader — a drop-in surface over the pure modules
 * (`scheduler`/`usage`/`validation`/`summaries`/`trajectory`/`protocol`/
 * `config`/`registry`/`gatekeeper`). Each wrapper (de)serializes JSON at the
 * seam; the raw wasm-bindgen functions live in `./generated/kernel-glue.js`.
 *
 * Safety net: when the WASM kernel is not built (`KERNEL_WASM_READY = false`)
 * or fails to initialize, every wrapper transparently falls back to the
 * existing TypeScript implementation, so callers keep working without a Rust
 * toolchain. Progressive migration swaps individual `import { fn } from
 * "./scheduler.js"` sites over to `from "./wasm-kernel.js"` one module at a
 * time.
 *
 * The kernel is initialized once via top-level await on first import.
 */

import type { ShadowActivationDecision, ShadowConfig, ShadowDefinition } from "./types.js";
import type { ShadowUsage } from "./usage.js";
import type { GatekeeperActivation } from "./gatekeeper.js";
import type { ToolResultLike } from "./summaries.js";
import type { MessageLike } from "./trajectory.js";
import {
  init,
  schedulerExtractToolNames,
  schedulerShouldEvaluateHeartbeat,
  schedulerShouldEvaluateFinalResponse,
  schedulerSelectCandidates,
  schedulerDecideFinalResponse,
  schedulerMatchesModel,
  schedulerMatchesActivationTools,
  usageZeroUsage,
  usageAdd,
  usageFormatTokens,
  usageFormatCost,
  usageFormatSummary,
  usageFormatDetail,
  validationCleanStringArray,
  validationIsThinkingLevel,
  validationIsStringArray,
  summariesSummarizeToolResult,
  trajectorySerialize,
  protocolBuildShadowRequest,
  configParse,
  configSerialize,
  registryParseShadowDefinition,
  gatekeeperBuildPrompt,
  gatekeeperFitTrajectory,
  gatekeeperParseReply,
} from "./generated/kernel-glue.js";
import { KERNEL_WASM_BASE64, KERNEL_WASM_READY } from "./generated/kernel-wasm.js";

// TypeScript fallbacks — the existing pure modules, kept as a safety net so
// callers keep working when the WASM kernel is absent or fails to init.
import * as tsScheduler from "./scheduler.js";
import * as tsUsage from "./usage.js";
import * as tsValidation from "./validation.js";
import * as tsSummaries from "./summaries.js";
import * as tsTrajectory from "./trajectory.js";
import * as tsProtocol from "./protocol.js";
import * as tsConfig from "./config.js";
import * as tsRegistry from "./registry.js";
import * as tsGatekeeper from "./gatekeeper.js";

let wasmReady = false;
if (KERNEL_WASM_READY) {
  try {
    // `init` accepts a Uint8Array directly (wasm-bindgen `--target web`).
    await init(Buffer.from(KERNEL_WASM_BASE64, "base64"));
    wasmReady = true;
  } catch (error) {
    console.warn(
      "[wasm-kernel] WASM init failed; falling back to TypeScript implementations:",
      error,
    );
  }
}

// --- scheduler ---------------------------------------------------------------

export function extractToolNames(toolResults: readonly unknown[]): Set<string> {
  if (!wasmReady) return tsScheduler.extractToolNames(toolResults);
  return new Set(JSON.parse(schedulerExtractToolNames(JSON.stringify(toolResults))) as string[]);
}

export function shouldEvaluateHeartbeat(
  toolsOrResults: readonly unknown[] | ReadonlySet<string>,
  heartbeatTools?: readonly string[],
): boolean {
  if (!wasmReady) return tsScheduler.shouldEvaluateHeartbeat(toolsOrResults, heartbeatTools);
  const toolNames =
    toolsOrResults instanceof Set
      ? Array.from(toolsOrResults as ReadonlySet<string>)
      : extractToolNames(toolsOrResults as readonly unknown[]);
  return schedulerShouldEvaluateHeartbeat(
    JSON.stringify({ toolNames, heartbeatTools: heartbeatTools ?? [] }),
  );
}

export function shouldEvaluateFinalResponse(messages: readonly unknown[]): boolean {
  if (!wasmReady) return tsScheduler.shouldEvaluateFinalResponse(messages);
  return schedulerShouldEvaluateFinalResponse(JSON.stringify(messages));
}

export function selectCandidates(options: {
  shadows: readonly ShadowDefinition[];
  activeShadowIds: ReadonlySet<string>;
  mainModelId: string;
  executedTools?: ReadonlySet<string> | readonly string[];
}): {
  candidates: ShadowDefinition[];
  disabled: string[];
  modelFiltered: string[];
  runningExcluded: string[];
  toolFiltered: string[];
} {
  if (!wasmReady) return tsScheduler.selectCandidates(options);
  const executedTools = options.executedTools
    ? Array.from(options.executedTools as ReadonlySet<string>)
    : undefined;
  return JSON.parse(
    schedulerSelectCandidates(
      JSON.stringify({
        shadows: options.shadows,
        activeShadowIds: Array.from(options.activeShadowIds),
        mainModelId: options.mainModelId,
        executedTools,
      }),
    ),
  );
}

export function decideFinalResponse(options: {
  shadows: readonly ShadowDefinition[];
  mainModelId: string;
  canRunFinalResponse?: (shadow: ShadowDefinition) => boolean;
}): ShadowActivationDecision {
  if (!wasmReady) return tsScheduler.decideFinalResponse(options);
  // JS callback can't cross the WASM boundary → precompute a {id: bool} map.
  const canRunMap = options.canRunFinalResponse
    ? Object.fromEntries(
        options.shadows.map(
          (s) => [s.id, options.canRunFinalResponse!(s)] as [string, boolean],
        ),
      )
    : undefined;
  return JSON.parse(
    schedulerDecideFinalResponse(
      JSON.stringify({ shadows: options.shadows, mainModelId: options.mainModelId, canRunMap }),
    ),
  );
}

export function matchesModel(shadow: ShadowDefinition, fullModelId: string): boolean {
  if (!wasmReady) return tsScheduler.matchesModel(shadow, fullModelId);
  return schedulerMatchesModel(JSON.stringify({ shadow, mainModelId: fullModelId }));
}

export function matchesActivationTools(
  shadow: ShadowDefinition,
  executedTools?: ReadonlySet<string> | readonly string[],
): boolean {
  if (!wasmReady) return tsScheduler.matchesActivationTools(shadow, executedTools);
  const tools = executedTools
    ? Array.from(executedTools as ReadonlySet<string>)
    : undefined;
  return schedulerMatchesActivationTools(JSON.stringify({ shadow, executedTools: tools }));
}

// --- usage -------------------------------------------------------------------

export function zeroUsage(): ShadowUsage {
  if (!wasmReady) return tsUsage.zeroUsage();
  return JSON.parse(usageZeroUsage()) as ShadowUsage;
}

export function addUsage(left: ShadowUsage, right: ShadowUsage): ShadowUsage {
  if (!wasmReady) return tsUsage.addUsage(left, right);
  return JSON.parse(usageAdd(JSON.stringify({ left, right }))) as ShadowUsage;
}

export function formatUsageTokens(tokens: number): string {
  if (!wasmReady) return tsUsage.formatUsageTokens(tokens);
  return usageFormatTokens(tokens);
}

export function formatUsageCost(cost: number): string {
  if (!wasmReady) return tsUsage.formatUsageCost(cost);
  return usageFormatCost(cost);
}

export function formatUsageSummary(usage: ShadowUsage): string {
  if (!wasmReady) return tsUsage.formatUsageSummary(usage);
  return usageFormatSummary(JSON.stringify(usage));
}

export function formatUsageDetail(scope: string, usage: ShadowUsage): string {
  if (!wasmReady) return tsUsage.formatUsageDetail(scope, usage);
  return usageFormatDetail(JSON.stringify({ scope, usage }));
}

// --- validation --------------------------------------------------------------

export function cleanStringArray(
  value: unknown,
  fallback: readonly string[],
  name: string,
): string[] {
  if (!wasmReady) return tsValidation.cleanStringArray(value, fallback as string[], name);
  // Match TS throwing on null; undefined → omit (Rust treats absent as fallback).
  if (value === null) throw new Error(`${name} must be an array of non-empty strings`);
  const input = value === undefined ? { fallback, name } : { value, fallback, name };
  return JSON.parse(validationCleanStringArray(JSON.stringify(input))) as string[];
}

export function isThinkingLevel(value: unknown): boolean {
  if (!wasmReady) return tsValidation.isThinkingLevel(value);
  return validationIsThinkingLevel(JSON.stringify(value ?? null));
}

export function isStringArray(value: unknown): boolean {
  if (!wasmReady) return tsValidation.isStringArray(value);
  return validationIsStringArray(JSON.stringify(value ?? null));
}

// --- summaries / trajectory / protocol ---------------------------------------

export function summarizeToolResult(result: unknown): string {
  if (!wasmReady) return tsSummaries.summarizeToolResult(result as ToolResultLike);
  return summariesSummarizeToolResult(JSON.stringify(result));
}

export function serializeTrajectory(messages: readonly unknown[]): string {
  if (!wasmReady) return tsTrajectory.serializeTrajectory(messages as readonly MessageLike[]);
  return trajectorySerialize(JSON.stringify(messages));
}

export function buildShadowRequest(
  trajectory: string,
  shadow: ShadowDefinition,
  brief?: string,
): string {
  if (!wasmReady) return tsProtocol.buildShadowRequest(trajectory, shadow, brief);
  return protocolBuildShadowRequest(JSON.stringify({ trajectory, shadow, brief }));
}

// --- config / registry -------------------------------------------------------

export function parseConfig(input: unknown): ShadowConfig {
  if (!wasmReady) return tsConfig.parseConfig(input);
  return JSON.parse(configParse(JSON.stringify(input))) as ShadowConfig;
}

export function serializeConfig(config: ShadowConfig): string {
  if (!wasmReady) return tsConfig.serializeConfig(config);
  return configSerialize(JSON.stringify(config));
}

export function parseShadowDefinition(
  meta: unknown,
  body: string,
  filePath: string,
  fallbackId: string,
): ShadowDefinition {
  if (!wasmReady) return tsRegistry.parseShadowDefinition(meta, body, filePath, fallbackId);
  return JSON.parse(
    registryParseShadowDefinition(JSON.stringify({ meta, body, filePath, fallbackId })),
  ) as ShadowDefinition;
}

// --- gatekeeper --------------------------------------------------------------

export function buildGatekeeperPrompt(
  candidates: readonly ShadowDefinition[],
  trajectory: string,
): { systemPrompt: string; userMessage: string; candidateSummaries: string } {
  if (!wasmReady) return tsGatekeeper.buildGatekeeperPrompt(candidates, trajectory);
  return JSON.parse(gatekeeperBuildPrompt(JSON.stringify({ candidates, trajectory })));
}

export function fitTrajectory(
  trajectory: string,
  contextWindowChars: number,
  reservedChars = 0,
): { text: string; truncated: boolean } {
  if (!wasmReady) return tsGatekeeper.fitTrajectory(trajectory, contextWindowChars, reservedChars);
  return JSON.parse(
    gatekeeperFitTrajectory(JSON.stringify({ trajectory, contextWindowChars, reservedChars })),
  );
}

export function parseGatekeeperReply(
  text: string,
  candidateIds: ReadonlySet<string>,
): GatekeeperActivation[] {
  if (!wasmReady) return tsGatekeeper.parseGatekeeperReply(text, candidateIds);
  return JSON.parse(
    gatekeeperParseReply(JSON.stringify({ text, candidateIds: Array.from(candidateIds) })),
  ) as GatekeeperActivation[];
}
