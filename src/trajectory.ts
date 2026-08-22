import { summarizeToolResult } from "./summaries.js";

type MessageLike = { role?: string; content?: unknown; [key: string]: unknown };

/**
 * Delivered shadow reports stay in the session forever and are replayed into
 * every new trajectory, so carrying all of them grows O(N) until the trajectory
 * no longer fits. Keep the most recent few within a total character budget,
 * dropping oldest first behind an explicit omission marker (DESIGN.md §6 keeps
 * the feedback chain, just bounded).
 */
const SHADOW_FEEDBACK_MAX_REPORTS = 3;
const SHADOW_FEEDBACK_MAX_CHARS = 4000;

export function serializeTrajectory(messages: readonly MessageLike[]): string {
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      results.set(message.toolCallId, summarizeToolResult(message));
    }
  }

  const feedbackTexts: string[] = [];
  for (const message of messages) {
    if (message.role === "custom" && message.customType === "shadow-report") {
      const text = extractText(message.content);
      if (text) feedbackTexts.push(text);
    }
  }
  const keptFeedback = selectShadowFeedback(feedbackTexts);

  const lines: string[] = [];
  let seenFeedback = 0;
  let omittedMarked = false;
  for (const message of messages) {
    if (message.role === "user") {
      appendText(lines, "USER", message.content);
      continue;
    }
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) {
        appendText(lines, "MAIN", message.content);
        continue;
      }
      for (const block of message.content) {
        if (!block || typeof block !== "object" || isThinkingBlock(block)) continue;
        const item = block as { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
        if (item.type === "text" && item.text) lines.push(`MAIN: ${flat(item.text)}`);
        if (item.type === "toolCall" && item.name) {
          const call = `${item.name}(${compactJson(item.arguments)})`;
          const result = item.id ? results.get(item.id) : undefined;
          lines.push(`TOOL: ${call}${result ? ` · ${result}` : ""}`);
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !results.has(message.toolCallId)) {
        lines.push(`TOOL RESULT: ${summarizeToolResult(message)}`);
      }
      continue;
    }
    if (message.role === "custom" && message.customType === "shadow-report") {
      const text = extractText(message.content);
      if (!text) continue;
      seenFeedback += 1;
      if (seenFeedback > feedbackTexts.length - keptFeedback) {
        lines.push(`SHADOW FEEDBACK: ${text}`);
      } else if (!omittedMarked) {
        const omitted = feedbackTexts.length - keptFeedback;
        lines.push(`SHADOW FEEDBACK: (${omitted} older report${omitted === 1 ? "" : "s"} omitted)`);
        omittedMarked = true;
      }
      continue;
    }
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      appendText(lines, "SUMMARY", message.content);
    }
  }
  return `<main-agent-trajectory>\n${lines.join("\n")}\n</main-agent-trajectory>`;
}

function selectShadowFeedback(texts: readonly string[]): number {
  let kept = 0;
  let chars = 0;
  for (let index = texts.length - 1; index >= 0 && kept < SHADOW_FEEDBACK_MAX_REPORTS; index -= 1) {
    const text = texts[index];
    if (chars + text.length > SHADOW_FEEDBACK_MAX_CHARS) continue;
    kept += 1;
    chars += text.length;
  }
  return kept;
}

function isThinkingBlock(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && (value as { type?: string }).type === "thinking";
}

function appendText(lines: string[], label: string, content: unknown): void {
  const text = extractText(content);
  if (text) lines.push(`${label}: ${text}`);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return flat(content);
  if (!Array.isArray(content)) return "";
  return flat(
    content
      .filter((item): item is { type?: string; text?: string } => Boolean(item) && typeof item === "object")
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n"),
  );
}

/** Collapse embedded whitespace/newlines so every transcript line keeps its label. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function compactJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
