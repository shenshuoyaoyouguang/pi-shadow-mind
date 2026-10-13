//! Conversation trajectory serialization, mirroring `src/trajectory.ts`.
//! Pure function over message-shaped JSON. Custom JS summarizers stay in TS; the
//! Rust side uses only the built-in summarizers (read/grep/find/ls + generic),
//! which is identical when no plugin summarizer is registered.

use crate::summaries::summarize_tool_result;
use crate::util::{flatten_ws, utf16_len};
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const SHADOW_FEEDBACK_MAX_REPORTS: usize = 3;
const SHADOW_FEEDBACK_MAX_CHARS: usize = 4000;

static ROLE_LINE_RE: OnceLock<Regex> = OnceLock::new();
fn role_line_re() -> &'static Regex {
    // /^(?:USER|MAIN|TOOL|SHADOW)[:：]/i  — fullwidth colon U+FF1A included.
    ROLE_LINE_RE.get_or_init(|| Regex::new("(?i)^(?:USER|MAIN|TOOL|SHADOW)[:：]").unwrap())
}

pub fn serialize_trajectory(messages: &[Value]) -> String {
    // toolCallId -> summarizeToolResult(msg), mirroring the first pass.
    let mut results: HashMap<String, String> = HashMap::new();
    for msg in messages {
        let obj = match msg.as_object() {
            Some(o) => o,
            None => continue,
        };
        if obj.get("role").and_then(|v| v.as_str()) == Some("toolResult") {
            if let Some(id) = obj.get("toolCallId").and_then(|v| v.as_str()) {
                results.insert(id.to_string(), summarize_tool_result(msg));
            }
        }
    }

    // Sanitized shadow-report feedback texts, in message order.
    let mut feedback_texts: Vec<String> = Vec::new();
    for msg in messages {
        let obj = match msg.as_object() {
            Some(o) => o,
            None => continue,
        };
        if obj.get("role").and_then(|v| v.as_str()) == Some("custom")
            && obj.get("customType").and_then(|v| v.as_str()) == Some("shadow-report")
        {
            let raw = extract_raw_text(obj.get("content"));
            if flatten_ws(&raw).is_empty() {
                continue;
            }
            feedback_texts.push(sanitize_report_content(&raw));
        }
    }
    let kept_feedback = select_shadow_feedback(&feedback_texts);

    let mut lines: Vec<String> = Vec::new();
    let mut feedback_index: i64 = -1;
    let mut omitted_marked = false;
    for msg in messages {
        let obj = match msg.as_object() {
            Some(o) => o,
            None => continue,
        };
        let role = obj.get("role").and_then(|v| v.as_str());
        match role {
            Some("user") => append_text(&mut lines, "USER", obj.get("content")),
            Some("assistant") => {
                let content = obj.get("content");
                match content {
                    Some(Value::Array(blocks)) => {
                        for block in blocks {
                            let b = match block.as_object() {
                                Some(o) => o,
                                None => continue,
                            };
                            if is_thinking_block(b) {
                                continue;
                            }
                            if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                                if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                                    if !t.is_empty() {
                                        lines.push(format!("MAIN: {}", flatten_ws(t)));
                                    }
                                }
                            }
                            if b.get("type").and_then(|v| v.as_str()) == Some("toolCall") {
                                if let Some(name) = b.get("name").and_then(|v| v.as_str()) {
                                    if !name.is_empty() {
                                        let call = format!(
                                            "{}({})",
                                            name,
                                            compact_json(b.get("arguments"))
                                        );
                                        let result = b
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .and_then(|id| results.get(id));
                                        match result {
                                            Some(r) => lines.push(format!("TOOL: {} · {}", call, r)),
                                            None => lines.push(format!("TOOL: {}", call)),
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => append_text(&mut lines, "MAIN", content),
                }
            }
            Some("toolResult") => {
                let has_id = obj
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .is_some_and(|id| results.contains_key(id));
                if !has_id {
                    lines.push(format!("TOOL RESULT: {}", summarize_tool_result(msg)));
                }
            }
            Some("custom")
                if obj.get("customType").and_then(|v| v.as_str()) == Some("shadow-report") =>
            {
                feedback_index += 1;
                if kept_feedback.contains(&(feedback_index as usize)) {
                    lines.push(format!(
                        "SHADOW FEEDBACK: {}",
                        feedback_texts[feedback_index as usize]
                    ));
                } else if !omitted_marked {
                    let omitted = feedback_texts.len() - kept_feedback.len();
                    let plural = if omitted == 1 { "" } else { "s" };
                    lines.push(format!(
                        "SHADOW FEEDBACK: ({} report{} omitted)",
                        omitted, plural
                    ));
                    omitted_marked = true;
                }
            }
            Some("compactionSummary") | Some("branchSummary") => {
                let summary_val = obj.get("summary").or_else(|| obj.get("content"));
                let text = extract_raw_text(summary_val);
                if !text.trim().is_empty() {
                    lines.push(format!("SUMMARY: {}", text));
                }
            }
            _ => {}
        }
    }
    format!(
        "<main-agent-trajectory>\n{}\n</main-agent-trajectory>",
        lines.join("\n")
    )
}

fn select_shadow_feedback(texts: &[String]) -> HashSet<usize> {
    let mut kept = HashSet::new();
    let mut chars = 0usize;
    let mut count = 0usize;
    let mut index = texts.len() as i64 - 1;
    while index >= 0 && count < SHADOW_FEEDBACK_MAX_REPORTS {
        let i = index as usize;
        let tlen = utf16_len(&texts[i]);
        if chars + tlen > SHADOW_FEEDBACK_MAX_CHARS {
            index -= 1;
            continue;
        }
        kept.insert(i);
        chars += tlen;
        count += 1;
        index -= 1;
    }
    kept
}

fn is_thinking_block(obj: &serde_json::Map<String, Value>) -> bool {
    obj.get("type").and_then(|v| v.as_str()) == Some("thinking")
}

fn append_text(lines: &mut Vec<String>, label: &str, content: Option<&Value>) {
    let text = extract_text(content);
    if !text.is_empty() {
        lines.push(format!("{}: {}", label, text));
    }
}

fn extract_text(content: Option<&Value>) -> String {
    flatten_ws(&extract_raw_text(content))
}

fn extract_raw_text(content: Option<&Value>) -> String {
    match content {
        None => String::new(),
        Some(Value::String(s)) => s.to_string(),
        Some(Value::Array(arr)) => {
            let mut parts = Vec::new();
            for item in arr {
                let obj = match item.as_object() {
                    Some(o) => o,
                    None => continue,
                };
                if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                    parts.push(
                        obj.get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    );
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}

fn sanitize_report_content(text: &str) -> String {
    let filtered: Vec<&str> = text
        .split('\n')
        .filter(|line| !role_line_re().is_match(line.trim()))
        .collect();
    flatten_ws(&filtered.join(" "))
}

fn compact_json(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "[unserializable]".to_string()),
    }
}
