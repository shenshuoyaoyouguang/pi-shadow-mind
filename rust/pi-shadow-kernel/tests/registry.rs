//! Behavior equivalence for `registry.rs` (mirrors `test/registry.test.ts` intent).

use pi_shadow_kernel::registry::parse_shadow_definition;
use pi_shadow_kernel::types::{ShadowTrigger, ThinkingLevel};
use serde_json::{json, Value};

#[test]
fn falls_back_to_file_basename_for_id() {
    let meta = json!({"name": "Reviewer"});
    let def = parse_shadow_definition(&meta, "Check the code.", "reviewer.md", "reviewer").unwrap();
    assert_eq!(def.id, "reviewer");
    assert_eq!(def.name, "Reviewer");
    assert_eq!(def.prompt, "Check the code.");
    assert_eq!(def.trigger, vec![ShadowTrigger::Heartbeat]);
    assert_eq!(def.active_for_models, vec!["*".to_string()]);
    assert!(def.enabled);
    assert!(!def.debug);
}

#[test]
fn uses_explicit_id_and_fields() {
    let meta = json!({"id": "code-reviewer", "name": "Reviewer", "trigger": ["final_response"], "active_for_models": ["anthropic/*"], "enabled": false, "debug": true, "timeout_seconds": 120, "final_response_rounds": 2, "activation_tools": ["read"], "tools": ["read", "grep"]});
    let def = parse_shadow_definition(&meta, "prompt body", "f.md", "fallback").unwrap();
    assert_eq!(def.id, "code-reviewer");
    assert_eq!(def.trigger, vec![ShadowTrigger::FinalResponse]);
    assert_eq!(def.active_for_models, vec!["anthropic/*".to_string()]);
    assert!(!def.enabled);
    assert!(def.debug);
    assert_eq!(def.timeout_seconds, Some(120.0));
    assert_eq!(def.final_response_rounds, Some(2));
    assert_eq!(def.activation_tools, vec!["read".to_string()]);
    assert_eq!(def.tools, vec!["read".to_string(), "grep".to_string()]);
}

#[test]
fn rejects_invalid_id() {
    let meta = json!({"id": "Bad ID"});
    assert!(parse_shadow_definition(&meta, "p", "f.md", "x").is_err());
}

#[test]
fn rejects_empty_prompt_body() {
    let meta: Value = json!({});
    assert!(parse_shadow_definition(&meta, "   ", "f.md", "x").is_err());
}

#[test]
fn rejects_invalid_trigger() {
    let meta = json!({"trigger": ["bogus"]});
    assert!(parse_shadow_definition(&meta, "p", "f.md", "x").is_err());
}

#[test]
fn preserves_unknown_frontmatter_as_extra_fields() {
    let meta = json!({"custom_key": 42, "another": "v"});
    let def = parse_shadow_definition(&meta, "p", "f.md", "x").unwrap();
    let extra = def.extra_fields.unwrap();
    assert_eq!(extra.get("custom_key"), Some(&json!(42)));
    assert_eq!(extra.get("another"), Some(&json!("v")));
}

#[test]
fn accepts_string_trigger_as_single_element() {
    let meta = json!({"trigger": "final_response"});
    let def = parse_shadow_definition(&meta, "p", "f.md", "x").unwrap();
    assert_eq!(def.trigger, vec![ShadowTrigger::FinalResponse]);
}

#[test]
fn rejects_non_object_frontmatter() {
    assert!(parse_shadow_definition(&json!(42), "p", "f.md", "x").is_err());
    assert!(parse_shadow_definition(&json!("string"), "p", "f.md", "x").is_err());
}

#[test]
fn rejects_non_boolean_enabled() {
    let meta = json!({"enabled": "yes"});
    assert!(parse_shadow_definition(&meta, "p", "f.md", "x").is_err());
}

#[test]
fn rejects_non_positive_timeout() {
    assert!(parse_shadow_definition(&json!({"timeout_seconds": 0}), "p", "f.md", "x").is_err());
    assert!(parse_shadow_definition(&json!({"timeout_seconds": -5}), "p", "f.md", "x").is_err());
    assert!(parse_shadow_definition(&json!({"timeout_seconds": "fast"}), "p", "f.md", "x").is_err());
}

#[test]
fn rejects_negative_and_fractional_rounds() {
    assert!(parse_shadow_definition(&json!({"final_response_rounds": -1}), "p", "f.md", "x").is_err());
    assert!(parse_shadow_definition(&json!({"final_response_rounds": 1.5}), "p", "f.md", "x").is_err());
}

#[test]
fn accepts_multiple_triggers_deduped() {
    let meta = json!({"trigger": ["heartbeat", "final_response", "heartbeat"]});
    let def = parse_shadow_definition(&meta, "p", "f.md", "x").unwrap();
    assert_eq!(def.trigger, vec![ShadowTrigger::Heartbeat, ShadowTrigger::FinalResponse]);
}

#[test]
fn accepts_run_with_model_and_thinking_level() {
    let meta = json!({"run_with_model": "anthropic/claude", "thinking_level": "high"});
    let def = parse_shadow_definition(&meta, "p", "f.md", "x").unwrap();
    assert_eq!(def.run_with_model.as_deref(), Some("anthropic/claude"));
    assert_eq!(def.thinking_level, Some(ThinkingLevel::High));
}

#[test]
fn rejects_invalid_thinking_level() {
    assert!(parse_shadow_definition(&json!({"thinking_level": "bogus"}), "p", "f.md", "x").is_err());
}
