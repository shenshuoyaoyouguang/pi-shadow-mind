// AUTO-GENERATED types for the wasm-bindgen `--target web` glue.
// Stable hand-written declaration; `rust/build-wasm.mjs` regenerates the matching
// `kernel-glue.js` from `wasm-pack` output. The raw functions take/return JS
// values (wasm-bindgen marshals strings/bools across the boundary).

export function init(module_or_path?: Uint8Array | URL | WebAssembly.Module): Promise<unknown>;

export function schedulerExtractToolNames(input: string): string;
export function schedulerShouldEvaluateHeartbeat(input: string): boolean;
export function schedulerShouldEvaluateFinalResponse(input: string): boolean;
export function schedulerSelectCandidates(input: string): string;
export function schedulerDecideFinalResponse(input: string): string;
export function schedulerMatchesModel(input: string): boolean;
export function schedulerMatchesActivationTools(input: string): boolean;

export function usageZeroUsage(): string;
export function usageAdd(input: string): string;
export function usageFormatTokens(tokens: number): string;
export function usageFormatCost(cost: number): string;
export function usageFormatSummary(input: string): string;
export function usageFormatDetail(input: string): string;

export function validationCleanStringArray(input: string): string;
export function validationIsThinkingLevel(input: string): boolean;
export function validationIsStringArray(input: string): boolean;

export function summariesSummarizeToolResult(input: string): string;
export function trajectorySerialize(input: string): string;
export function protocolBuildShadowRequest(input: string): string;
export function configParse(input: string): string;
export function configSerialize(input: string): string;
export function registryParseShadowDefinition(input: string): string;

export function gatekeeperBuildPrompt(input: string): string;
export function gatekeeperFitTrajectory(input: string): string;
export function gatekeeperParseReply(input: string): string;
