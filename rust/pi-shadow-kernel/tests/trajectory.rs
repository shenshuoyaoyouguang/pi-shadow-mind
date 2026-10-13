//! Behavior equivalence for `trajectory.rs` (mirrors `test/trajectory.test.ts` intent).

use pi_shadow_kernel::trajectory::serialize_trajectory;
use serde_json::{json, Value};

#[test]
fn renders_user_and_assistant_text() {
    let messages: Vec<Value> = vec![
        json!({"role": "user", "content": "do something"}),
        json!({"role": "assistant", "content": [{"type": "text", "text": "working"}]}),
    ];
    let out = serialize_trajectory(&messages);
    assert!(out.starts_with("<main-agent-trajectory>"));
    assert!(out.contains("USER: do something"));
    assert!(out.contains("MAIN: working"));
}

#[test]
fn renders_tool_call_with_inlined_result() {
    let messages: Vec<Value> = vec![
        json!({"role": "user", "content": "task"}),
        json!({"role": "assistant", "content": [{"type": "toolCall", "id": "c1", "name": "read", "arguments": {"path": "x"}}]}),
        json!({"role": "toolResult", "toolCallId": "c1", "toolName": "read", "content": [{"type": "text", "text": "line1\nline2"}]}),
    ];
    let out = serialize_trajectory(&messages);
    assert!(out.contains("TOOL: read("));
    assert!(out.contains("2 read · line1"));
}

#[test]
fn skips_thinking_blocks() {
    let messages: Vec<Value> = vec![
        json!({"role": "user", "content": "task"}),
        json!({"role": "assistant", "content": [{"type": "thinking", "text": "hidden"}, {"type": "text", "text": "shown"}]}),
    ];
    let out = serialize_trajectory(&messages);
    assert!(out.contains("MAIN: shown"));
    assert!(!out.contains("hidden"));
}

#[test]
fn keeps_recent_shadow_feedback_within_budget() {
    let mk = |text: &str| json!({"role": "custom", "customType": "shadow-report", "content": [{"type": "text", "text": text}]});
    let messages: Vec<Value> = vec![
        json!({"role": "user", "content": "task"}),
        mk("first report"),
        mk("second report"),
    ];
    let out = serialize_trajectory(&messages);
    assert!(out.contains("SHADOW FEEDBACK: second report"));
    // Only the most recent 3 are kept; both fit, so no omission marker.
    assert!(!out.contains("omitted"));
}

#[test]
fn marks_omitted_shadow_feedback() {
    let mk = |text: &str| json!({"role": "custom", "customType": "shadow-report", "content": [{"type": "text", "text": text}]});
    // Four reports: the oldest is dropped behind an omission marker.
    let messages: Vec<Value> = vec![
        json!({"role": "user", "content": "task"}),
        mk("r1"),
        mk("r2"),
        mk("r3"),
        mk("r4"),
    ];
    let out = serialize_trajectory(&messages);
    assert!(out.contains("SHADOW FEEDBACK: (1 report omitted)"));
    assert!(out.contains("SHADOW FEEDBACK: r4"));
    assert!(!out.contains("SHADOW FEEDBACK: r1"));
}
