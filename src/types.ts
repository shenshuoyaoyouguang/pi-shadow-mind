import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const DEFAULT_READ_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface ShadowConfig {
  heartbeatProbability: number;
  maxParallelShadows: number;
  defaultShadowTimeoutSeconds: number;
  headlessDrainTimeoutSeconds: number;
  resultBatchWindowMs: number;
  defaultShadowModel?: string;
  /** Gatekeeper model full id; omitted → defaultShadowModel → main model. */
  gatekeeperModel?: string;
  defaultThinkingLevel: ThinkingLevel;
  randomSeed?: number;
  extraFields?: Record<string, unknown>;
}

export interface ShadowDefinition {
  id: string;
  name: string;
  enabled: boolean;
  debug: boolean;
  activationProbability: number;
  activeForModels: string[];
  runWithModel?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutSeconds?: number;
  tools: string[];
  prompt: string;
  filePath: string;
  /** Unknown frontmatter keys preserved verbatim across round-trips. */
  extraFields?: Record<string, unknown>;
}

export interface RegistryDiagnostic {
  filePath: string;
  message: string;
}

export interface RegistrySnapshot {
  shadows: ShadowDefinition[];
  diagnostics: RegistryDiagnostic[];
}

export type RunEndReason = "report" | "silent" | "timeout" | "aborted" | "error";

export interface ShadowReport {
  shadowId: string;
  shadowName: string;
  content: string;
  epoch: number;
  runId: string;
}

export interface RuntimeEvent {
  at: string;
  kind: string;
  epoch: number;
  data?: Record<string, unknown>;
}

export interface HeartbeatDecision {
  heartbeatRoll: number;
  activated: Array<{ shadow: ShadowDefinition; roll: number }>;
  candidates: Array<{ shadowId: string; roll: number; selected: boolean }>;
  /** Shadow ids excluded because active_for_models did not match the main model. */
  modelFiltered: string[];
  /** Shadow ids excluded because the same shadow is already running. */
  runningExcluded: string[];
}
