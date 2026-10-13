//! Tool-result summarizers mirroring `src/summaries.ts`.
//!
//! Only the four built-in summarizers (read/grep/find/ls) and the generic
//! fallback live here. The JS plugin extension point (`registerToolResultSummarizer`)
//! stays in TypeScript: arbitrary JS callbacks cannot run inside WASM. The TS
//! wrapper checks its custom registry first and only delegates to WASM for the
//! built-in path, so behavior is identical with or without custom summarizers.

use crate::util::{codepoint_count, codepoints_take, flatten_ws, utf16_len};
use serde_json::Value;

const PREVIEW_MAX_CHARS: usize = 200;

pub fn summarize_tool_result(result: &Value) -> String {
    let summary = match result.get("toolName").and_then(|v| v.as_str()) {
        Some("read") => summarize_lines(result, "read"),
        Some("grep") => summarize_lines(result, "matches"),
        Some("find") => summarize_lines(result, "paths"),
        Some("ls") => summarize_lines(result, "entries"),
        _ => summarize_generic(result),
    };
    let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
    if is_error {
        format!("error · {}", summary)
    } else {
        summary
    }
}

fn summarize_lines(result: &Value, noun: &str) -> String {
    let content = result.get("content").unwrap_or(&Value::Null);
    let text = text_content(content);
    if text.is_empty() {
        return format!("0 {}", noun);
    }
    let lines = non_empty_lines(&text);
    let preview = compact(lines.first().copied().unwrap_or(""));
    if preview.is_empty() {
        format!("{} {}", lines.len(), noun)
    } else {
        format!("{} {} · {}", lines.len(), noun, preview)
    }
}

fn summarize_generic(result: &Value) -> String {
    let content = result.get("content").unwrap_or(&Value::Null);
    describe_content(content).unwrap_or_else(|| "no output".to_string())
}

fn describe_content(content: &Value) -> Option<String> {
    match content {
        Value::Array(arr) => {
            let blocks: Vec<&Value> = arr.iter().filter(|v| v.is_object()).collect();
            if blocks.is_empty() {
                return Some("empty result".to_string());
            }
            let mut counts: Vec<(String, u32)> = Vec::new();
            for block in &blocks {
                let type_str = block
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("object")
                    .to_string();
                if let Some(entry) = counts.iter_mut().find(|(t, _)| *t == type_str) {
                    entry.1 += 1;
                } else {
                    counts.push((type_str, 1));
                }
            }
            Some(
                counts
                    .iter()
                    .map(|(t, c)| format!("{} {}{}", c, t, if *c > 1 { "s" } else { "" }))
                    .collect::<Vec<_>>()
                    .join(" · "),
            )
        }
        Value::Null => Some("null".to_string()),
        Value::String(s) => Some(format!("text · {} chars", utf16_len(s))),
        Value::Number(_) => Some(format!("number · {}", content)),
        Value::Bool(b) => Some(format!("boolean · {}", b)),
        Value::Object(obj) => Some(format!("object · {} keys", obj.len())),
    }
}

fn text_content(content: &Value) -> String {
    let arr = match content.as_array() {
        Some(a) => a,
        None => return String::new(),
    };
    let mut parts = Vec::new();
    for part in arr {
        let obj = match part.as_object() {
            Some(o) => o,
            None => continue,
        };
        if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
            parts.push(obj.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string());
        }
    }
    parts.join("\n")
}

/// `text.split(/\r?\n/).filter(Boolean)` — non-empty lines, trailing `\r` stripped.
fn non_empty_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.is_empty())
        .collect()
}

/// `compact(value)`: collapse whitespace, then cap by UTF-16 units and code
/// points alike, appending an ellipsis only when code points exceed the cap.
fn compact(value: &str) -> String {
    let collapsed = flatten_ws(value);
    if utf16_len(&collapsed) <= PREVIEW_MAX_CHARS {
        return collapsed;
    }
    if codepoint_count(&collapsed) <= PREVIEW_MAX_CHARS {
        return collapsed;
    }
    format!("{}…", codepoints_take(&collapsed, PREVIEW_MAX_CHARS))
}
