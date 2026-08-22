import { describe, expect, it } from "vitest";
import { serializeTrajectory } from "../src/trajectory.js";

const report = (text: string) => ({ role: "custom", customType: "shadow-report", content: text });

describe("serializeTrajectory", () => {
  it("renders a plain-text transcript and joins tool summaries to their calls", () => {
    const result = serializeTrajectory([
      { role: "user", content: [{ type: "text", text: "Inspect it." }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "Reading now." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
      ] },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "one\ntwo" }], isError: false },
      report("previous feedback"),
    ]);
    expect(result).toContain("USER: Inspect it.");
    expect(result).toContain("MAIN: Reading now.");
    expect(result).toContain('TOOL: read({"path":"a.ts"}) · 2 read · one');
    expect(result).toContain("SHADOW FEEDBACK: previous feedback");
    expect(result).not.toContain("secret");
  });

  it("keeps only the most recent shadow reports behind an omission marker", () => {
    const result = serializeTrajectory([
      report("stale one"),
      report("stale two"),
      report("fresh three"),
      report("fresh four"),
      report("fresh five"),
    ]);
    expect(result).toContain("(2 older reports omitted)");
    expect(result).toContain("SHADOW FEEDBACK: fresh three");
    expect(result).toContain("SHADOW FEEDBACK: fresh four");
    expect(result).toContain("SHADOW FEEDBACK: fresh five");
    expect(result).not.toContain("stale one");
    expect(result).not.toContain("stale two");
  });

  it("enforces a total character budget by dropping the oldest reports first", () => {
    const result = serializeTrajectory([
      report("x".repeat(4000)),
      report("recent"),
    ]);
    expect(result).toContain("(1 older report omitted)");
    expect(result).toContain("SHADOW FEEDBACK: recent");
    expect(result).not.toContain("xxxx");
  });

  it("omits an oversized newest shadow report instead of replaying it", () => {
    const oversized = "oversized-report-".repeat(300);
    const result = serializeTrajectory([report(oversized)]);
    expect(result).toContain("omitted");
    expect(result).not.toContain(oversized);
  });

  it("flattens newlines inside a message into single labeled lines", () => {
    const result = serializeTrajectory([
      { role: "user", content: [{ type: "text", text: "First line.\nSecond line." }] },
      { role: "assistant", content: [{ type: "text", text: "One\ntwo" }] },
      report("Report body\ncontinued here"),
    ]);
    expect(result).toContain("USER: First line. Second line.");
    expect(result).toContain("MAIN: One two");
    expect(result).toContain("SHADOW FEEDBACK: Report body continued here");
    for (const line of result.split("\n")) {
      expect(line).not.toMatch(/^(Second line|two|continued here)$/);
    }
  });
});
