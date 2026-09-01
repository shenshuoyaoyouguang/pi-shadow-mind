import { describe, expect, it } from "vitest";
import { summarizeToolResult } from "../src/summaries.js";

describe("summarizeToolResult", () => {
  it("summarizes known read tool by line count", () => {
    const summary = summarizeToolResult({ toolName: "read", content: [{ type: "text", text: "line1\nline2\nline3" }], isError: false });
    expect(summary).toBe("3 read · line1");
  });

  it("caps long single-line previews at 200 characters", () => {
    const summary = summarizeToolResult({ toolName: "read", content: [{ type: "text", text: "x".repeat(500) }], isError: false });
    expect(summary).toBe(`1 read · ${"x".repeat(200)}…`);
  });

  it("never splits an astral character at the preview boundary", () => {
    // 1 ASCII + 200 astral chars = 201 code points (401 UTF-16 units); a raw
    // slice(0, 200) would cut a surrogate pair in half at the 200-unit boundary.
    const summary = summarizeToolResult({ toolName: "read", content: [{ type: "text", text: `x${"𝄞".repeat(200)}` }], isError: false });
    const preview = summary.slice(summary.indexOf("· ") + 2);
    expect(Array.from(preview)).toHaveLength(201); // 200 kept code points + ellipsis
    expect(Array.from(preview).every((char) => char === "x" || char === "𝄞" || char === "…")).toBe(true);
  });

  it("does not add a false ellipsis when astral text fits in code points", () => {
    // 150 code points but 300 UTF-16 units: nothing is cut, so no ellipsis.
    const text = "𝄞".repeat(150);
    const summary = summarizeToolResult({ toolName: "read", content: [{ type: "text", text }], isError: false });
    expect(summary).toBe(`1 read · ${text}`);
  });

  it("keeps zero-line handling for empty read results", () => {
    const summary = summarizeToolResult({ toolName: "read", content: [{ type: "text", text: "" }], isError: false });
    expect(summary).toBe("0 read");
  });

  it("prefixes error status", () => {
    const summary = summarizeToolResult({ toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true });
    expect(summary).toMatch(/^error · /);
  });

  it("generic summarizer reports block type and scale, never content", () => {
    const summary = summarizeToolResult({ toolName: "custom-tool", content: [{ type: "text", text: "secret content that must not leak" }, { type: "image", data: "..." }] });
    expect(summary).toBe("1 text · 1 image");
    expect(summary).not.toContain("secret");
  });

  it("generic summarizer reports string scale for plain content", () => {
    const summary = summarizeToolResult({ toolName: "custom-tool", content: "hello world" });
    expect(summary).toBe("text · 11 chars");
  });

  it("generic summarizer handles empty and missing content", () => {
    expect(summarizeToolResult({ toolName: "custom-tool", content: [] })).toBe("empty result");
    expect(summarizeToolResult({ toolName: "custom-tool", content: undefined })).toBe("no output");
    expect(summarizeToolResult({ toolName: "custom-tool", content: null })).toBe("null");
  });
});
