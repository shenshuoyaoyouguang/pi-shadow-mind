//! Behavior-equivalence tests for `config::parse_config` / `serialize_config`.

use pi_shadow_kernel::config::{default_config, parse_config, serialize_config};
use pi_shadow_kernel::types::ThinkingLevel;

#[test]
fn parse_empty_object_yields_defaults() {
    let cfg = parse_config("{}").expect("empty config parses");
    let d = default_config();
    assert_eq!(cfg.heartbeat_tools, d.heartbeat_tools);
    assert_eq!(cfg.max_parallel_shadows, 2);
    assert_eq!(cfg.default_shadow_timeout_seconds, 300.0);
    assert_eq!(cfg.headless_drain_timeout_seconds, 120.0);
    assert_eq!(cfg.result_batch_window_ms, 400);
    assert_eq!(cfg.excluded_extensions, vec!["pi-experiencev2".to_string()]);
    assert_eq!(cfg.default_thinking_level, ThinkingLevel::Low);
    assert!(cfg.extra_fields.is_none());
}

#[test]
fn parse_overrides() {
    let raw = r#"{"max_parallel_shadows":4,"default_thinking_level":"high","heartbeat_tools":["read","grep"],"default_shadow_model":"anthropic/claude"}"#;
    let cfg = parse_config(raw).expect("overrides parse");
    assert_eq!(cfg.max_parallel_shadows, 4);
    assert_eq!(cfg.default_thinking_level, ThinkingLevel::High);
    assert_eq!(cfg.heartbeat_tools, vec!["read".to_string(), "grep".to_string()]);
    assert_eq!(cfg.default_shadow_model.as_deref(), Some("anthropic/claude"));
}

#[test]
fn serialize_default_omits_empty_heartbeat_and_optional_models() {
    let out = serialize_config(&default_config());
    assert!(out.contains("\"max_parallel_shadows\": 2"));
    assert!(out.contains("\"excluded_extensions\": [\n    \"pi-experiencev2\"\n  ]"));
    assert!(out.contains("\"default_thinking_level\": \"low\""));
    assert!(!out.contains("heartbeat_tools"));
    assert!(!out.contains("default_shadow_model"));
    assert!(out.ends_with('\n'));
}

#[test]
fn serialize_writes_heartbeat_tools_when_non_empty() {
    let mut cfg = default_config();
    cfg.heartbeat_tools = vec!["read".to_string()];
    let out = serialize_config(&cfg);
    assert!(out.contains("\"heartbeat_tools\": [\n    \"read\"\n  ]"));
}

#[test]
fn round_trip_is_stable() {
    let raw = r#"{"max_parallel_shadows":3,"default_shadow_timeout_seconds":120,"heartbeat_tools":["read"],"default_thinking_level":"medium"}"#;
    let cfg = parse_config(raw).expect("parse");
    let serialized = serialize_config(&cfg);
    let reparsed = parse_config(&serialized).expect("reparse");
    assert_eq!(reparsed.max_parallel_shadows, cfg.max_parallel_shadows);
    assert_eq!(reparsed.default_shadow_timeout_seconds, cfg.default_shadow_timeout_seconds);
    assert_eq!(reparsed.heartbeat_tools, cfg.heartbeat_tools);
    assert_eq!(reparsed.default_thinking_level, cfg.default_thinking_level);
}

#[test]
fn extra_fields_preserved_round_trip() {
    let raw = r#"{"max_parallel_shadows":2,"custom_note":"hi","nested":{"a":1}}"#;
    let cfg = parse_config(raw).expect("parse");
    let extra = cfg.extra_fields.as_ref().expect("extra fields present");
    assert_eq!(extra.get("custom_note").and_then(|v| v.as_str()), Some("hi"));
    let out = serialize_config(&cfg);
    assert!(out.contains("\"custom_note\": \"hi\""));
    assert!(out.contains("\"nested\""));
}

#[test]
fn rejects_invalid_thinking_level() {
    assert!(parse_config(r#"{"default_thinking_level":"bogus"}"#).is_err());
}

#[test]
fn rejects_non_object() {
    assert!(parse_config("[]").is_err());
    assert!(parse_config("null").is_err());
    assert!(parse_config("\"x\"").is_err());
}

#[test]
fn rejects_non_positive_parallel() {
    assert!(parse_config(r#"{"max_parallel_shadows":0}"#).is_err());
    assert!(parse_config(r#"{"max_parallel_shadows":-1}"#).is_err());
}

#[test]
fn rejects_non_integer_parallel() {
    assert!(parse_config(r#"{"max_parallel_shadows":2.5}"#).is_err());
}

#[test]
fn rejects_string_for_numeric_field() {
    assert!(parse_config(r#"{"max_parallel_shadows":"two"}"#).is_err());
}

#[test]
fn rejects_null_element_in_heartbeat_tools() {
    assert!(parse_config(r#"{"heartbeat_tools":["read",null]}"#).is_err());
}

#[test]
fn result_batch_window_allows_zero() {
    let cfg = parse_config(r#"{"result_batch_window_ms":0}"#).expect("zero allowed");
    assert_eq!(cfg.result_batch_window_ms, 0);
}

#[test]
fn rejects_negative_and_fractional_window() {
    assert!(parse_config(r#"{"result_batch_window_ms":-1}"#).is_err());
    assert!(parse_config(r#"{"result_batch_window_ms":1.5}"#).is_err());
}

#[test]
fn rejects_empty_default_shadow_model() {
    assert!(parse_config(r#"{"default_shadow_model":"  "}"#).is_err());
}

#[test]
fn serialize_includes_gatekeeper_and_extra_fields() {
    let cfg = parse_config(r#"{"gatekeeper_model":"openai/gpt","custom":7}"#).expect("parse");
    let out = serialize_config(&cfg);
    assert!(out.contains("\"gatekeeper_model\": \"openai/gpt\""));
    assert!(out.contains("\"custom\": 7"));
}
