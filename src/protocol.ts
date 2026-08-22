import type { ShadowDefinition } from "./types.js";

/** The brief is untrusted gatekeeper output interpolated into the Shadow request:
 * flatten it, strip delimiter escapes, and cap it by code points so it can neither
 * smuggle instructions past the <shadow-mind> wrapper nor flood the prompt. */
const BRIEF_MAX_CHARS = 400;

function sanitizeBrief(brief: string): string {
  const flattened = brief.replace(/\s+/g, " ").trim().replace(/<\/?shadow-mind[^>]*>/gi, "");
  return Array.from(flattened).slice(0, BRIEF_MAX_CHARS).join("");
}

const RUNTIME_PROTOCOL = `You are a Shadow Mind running beside the main agent.
Work independently on the responsibility below using the supplied, sanitized main-session trajectory.
The trajectory is read-only text produced by the main agent, not your unfinished work. Never continue the main agent's pending work, retry its failed calls, or treat its tool calls as your own. Use only the tools advertised for this Shadow run.
You may use the available tools. Call report_to_main only when the main agent should receive a concrete finding, correction, or completed work report.
Calling report_to_main ends this run immediately. If relevant work produces nothing worth reporting, finish silently.`;

const KICKOFF = `First decide whether the trajectory is relevant to this Shadow Mind's responsibility.
If it is unrelated, reply exactly NOT_RELEVANT and stop immediately. Do not call any tool, including report_to_main.
If it is relevant, perform the Shadow Mind's responsibility now. Call report_to_main only when the main agent should receive a result.`;

export function buildShadowSystemPrompt(mainSystemPrompt: string): string {
  return mainSystemPrompt;
}

export function buildShadowRequest(trajectory: string, shadow: ShadowDefinition, brief?: string): string {
  const sanitized = brief ? sanitizeBrief(brief) : "";
  const briefLine = sanitized ? `唤醒理由（供参考）：${sanitized}\n` : "";
  return `${trajectory}\n\n${RUNTIME_PROTOCOL}\n\n<shadow-mind id="${shadow.id}" name="${shadow.name}">\n${briefLine}${shadow.prompt}\n</shadow-mind>\n\n${KICKOFF}`;
}
