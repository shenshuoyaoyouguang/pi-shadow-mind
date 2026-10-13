//! Behavior equivalence for `summaries.rs` (mirrors `test/summaries` cases embedded
//! in `test/trajectory.test.ts` and the `src/summaries.ts` contract).

use pi_shadow_kernel::summaries::summarize_tool_result;
use serde_json::{json, Value};

#[test]
fn read_summarizer_counts_lines_and_previews_first() {
    let r = json!({"toolName": "read", "content": [{"type": "text", "text": "a\nb\nc"}]});
    assert_eq!(summarize_tool_result(&r), "3 read · a");
}

#[test]
fn grep_uses_matches_noun() {
    let r = json!({"toolName": "grep", "content": [{"type": "text", "text": "m1\nm2"}]});
    assert_eq!(summarize_tool_result(&r), "2 matches · m1");
}

#[test]
fn find_and_ls_nouns() {
    let r = json!({"toolName": "find", "content": [{"type": "text", "text": "p"}]});
    assert_eq!(summarize_tool_result(&r), "1 paths · p");
    let r = json!({"toolName": "ls", "content": [{"type": "text", "text": "e"}]});
    assert_eq!(summarize_tool_result(&r), "1 entries · e");
}

#[test]
fn empty_text_yields_zero_noun() {
    let r = json!({"toolName": "read", "content": []});
    assert_eq!(summarize_tool_result(&r), "0 read");
}

#[test]
fn error_prefix_wraps_summary() {
    let r = json!({"toolName": "read", "isError": true, "content": [{"type": "text", "text": "x"}]});
    assert_eq!(summarize_tool_result(&r), "error · 1 read · x");
}

#[test]
fn generic_object_describes_keys() {
    let r: Value = json!({"content": {"a": 1, "b": 2}});
    assert_eq!(summarize_tool_result(&r), "object · 2 keys");
}

#[test]
fn generic_string_describes_chars() {
    let r: Value = json!({"content": "hello"});
    assert_eq!(summarize_tool_result(&r), "text · 5 chars");
}

#[test]
fn generic_array_counts_block_types() {
    let r: Value = json!({"content": [{"type": "text", "text": "a"}, {"type": "image"}, {"type": "text", "text": "b"}]});
    assert_eq!(summarize_tool_result(&r), "2 texts · 1 image");
}

#[test]
fn preview_is_capped_at_200_code_points() {
    let long: String = "x".repeat(300);
    let r = json!({"toolName": "read", "content": [{"type": "text", "text": long}]});
    let out = summarize_tool_result(&r);
    // "1 read · " + 200 x's + "…"
    assert!(out.ends_with('…'));
    let preview = out.strip_prefix("1 read · ").unwrap();
    assert_eq!(preview.chars().count(), 201); // 200 x's + ellipsis
}

#[test]
fn generic_null_bool_number_content() {
    let r: Value = json!({"content": null});
    assert_eq!(summarize_tool_result(&r), "null");
    let r: Value = json!({"content": true});
    assert_eq!(summarize_tool_result(&r), "boolean · true");
    let r: Value = json!({"content": 42});
    assert_eq!(summarize_tool_result(&r), "number · 42");
}

#[test]
fn generic_empty_array_is_empty_result() {
    let r: Value = json!({"content": []});
    assert_eq!(summarize_tool_result(&r), "empty result");
}

#[test]
fn unknown_toolname_falls_back_to_generic() {
    let r: Value = json!({"toolName": "write", "content": "saved"});
    assert_eq!(summarize_tool_result(&r), "text · 5 chars");
}

#[test]
fn crlf_line_endings_are_split() {
    let r = json!({"toolName": "read", "content": [{"type": "text", "text": "a\r\nb\r\nc"}]});
    assert_eq!(summarize_tool_result(&r), "3 read · a");
}

#[test]
fn error_with_no_content() {
    let r: Value = json!({"toolName": "read", "isError": true});
    assert_eq!(summarize_tool_result(&r), "error · 0 read");
}
