/**
 * Typed WASM kernel loader — a drop-in surface over the pure modules
 * (`scheduler`/`usage`/`validation`/`summaries`/`trajectory`/`protocol`/
 * `config`/`registry`/`gatekeeper`). Each wrapper (de)serializes JSON at the
 * seam; the raw wasm-bindgen functions live in `./generated/kernel-glue.js`.
 *
 * This module is additive and is NOT imported by the existing runtime yet —
 * progressive migration swaps individual `import { fn } from "./scheduler.js"`
 * sites over to `from "./wasm-kernel.js"` one module at a time. Until then it
 * stays inert (and out of the esbuild bundle, so build invariants hold).
 *
 * The kernel is initialized once via top-level await on first import. When
 * `KERNEL_WASM_READY` is false (pre-build placeholder) initialization is
 * skipped and any wrapper call throws loudly via the stub glue.
 */

import type { ShadowActivationDecision, ShadowConfig, ShadowDefinition } from "./types.js";
import type { ShadowUsage } from "./usage.js";
import type { GatekeeperActivation } from "./gatekeeper.js";
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

if (KERNEL_WASM_READY) {
  // `init` accepts a Uint8Array directly (wasm-bindgen `--target web`).
  await init(Buffer.from(KERNEL_WASM_BASE64, "base64"));
}

// --- scheduler ---------------------------------------------------------------

export function extractToolNames(toolResults: readonly unknown[]): Set<string> {
  return new Set(JSON.parse(schedulerExtractToolNames(JSON.stringify(toolResults))) as string[]);
}

export function shouldEvaluateHeartbeat(
  toolsOrResults: readonly unknown[] | ReadonlySet<string>,
  heartbeatTools?: readonly string[],
): boolean {
  const toolNames =
    toolsOrResults instanceof Set
      ? Array.from(toolsOrResults as ReadonlySet<string>)
      : extractToolNames(toolsOrResults as readonly unknown[]);
  return schedulerShouldEvaluateHeartbeat(
    JSON.stringify({ toolNames, heartbeatTools: heartbeatTools ?? [] }),
  );
}

export function shouldEvaluateFinalResponse(messages: readonly unknown[]): boolean {
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
  return schedulerMatchesModel(JSON.stringify({ shadow, mainModelId: fullModelId }));
}

export function matchesActivationTools(
  shadow: ShadowDefinition,
  executedTools?: ReadonlySet<string> | readonly string[],
): boolean {
  const tools = executedTools
    ? Array.from(executedTools as ReadonlySet<string>)
    : undefined;
  return schedulerMatchesActivationTools(JSON.stringify({ shadow, executedTools: tools }));
}

// --- usage -------------------------------------------------------------------

export function zeroUsage(): ShadowUsage {
  return JSON.parse(usageZeroUsage()) as ShadowUsage;
}

export function addUsage(left: ShadowUsage, right: ShadowUsage): ShadowUsage {
  return JSON.parse(usageAdd(JSON.stringify({ left, right }))) as ShadowUsage;
}

export function formatUsageTokens(tokens: number): string {
  return usageFormatTokens(tokens);
}

export function formatUsageCost(cost: number): string {
  return usageFormatCost(cost);
}

export function formatUsageSummary(usage: ShadowUsage): string {
  return usageFormatSummary(JSON.stringify(usage));
}

export function formatUsageDetail(scope: string, usage: ShadowUsage): string {
  return usageFormatDetail(JSON.stringify({ scope, usage }));
}

// --- validation --------------------------------------------------------------

export function cleanStringArray(
  value: unknown,
  fallback: readonly string[],
  name: string,
): string[] {
  // undefined → omit the field (Rust treats absent as fallback);
  // null → include null (Rust errors, matching TS throwing on null).
  const input = value === undefined ? { fallback, name } : { value, fallback, name };
  return JSON.parse(validationCleanStringArray(JSON.stringify(input))) as string[];
}

export function isThinkingLevel(value: unknown): boolean {
  return validationIsThinkingLevel(JSON.stringify(value ?? null));
}

export function isStringArray(value: unknown): boolean {
  return validationIsStringArray(JSON.stringify(value ?? null));
}

// --- summaries / trajectory / protocol ---------------------------------------

export function summarizeToolResult(result: unknown): string {
  return summariesSummarizeToolResult(JSON.stringify(result));
}

export function serializeTrajectory(messages: readonly unknown[]): string {
  return trajectorySerialize(JSON.stringify(messages));
}

export function buildShadowRequest(
  trajectory: string,
  shadow: ShadowDefinition,
  brief?: string,
): string {
  return protocolBuildShadowRequest(JSON.stringify({ trajectory, shadow, brief }));
}

// --- config / registry -------------------------------------------------------

export function parseConfig(raw: string): ShadowConfig {
  return JSON.parse(configParse(raw)) as ShadowConfig;
}

export function serializeConfig(config: ShadowConfig): string {
  return configSerialize(JSON.stringify(config));
}

export function parseShadowDefinition(
  meta: unknown,
  body: string,
  filePath: string,
  fallbackId: string,
): ShadowDefinition {
  return JSON.parse(
    registryParseShadowDefinition(JSON.stringify({ meta, body, filePath, fallbackId })),
  ) as ShadowDefinition;
}

// --- gatekeeper --------------------------------------------------------------

export function buildGatekeeperPrompt(
  candidates: readonly ShadowDefinition[],
  trajectory: string,
): { systemPrompt: string; userMessage: string; candidateSummaries: string } {
  return JSON.parse(gatekeeperBuildPrompt(JSON.stringify({ candidates, trajectory })));
}

export function fitTrajectory(
  trajectory: string,
  contextWindowChars: number,
  reservedChars = 0,
): { text: string; truncated: boolean } {
  return JSON.parse(
    gatekeeperFitTrajectory(JSON.stringify({ trajectory, contextWindowChars, reservedChars })),
  );
}

export function parseGatekeeperReply(
  text: string,
  candidateIds: ReadonlySet<string>,
): GatekeeperActivation[] {
  return JSON.parse(
    gatekeeperParseReply(JSON.stringify({ text, candidateIds: Array.from(candidateIds) })),
  ) as GatekeeperActivation[];
}
