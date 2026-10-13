//! Direct tests for `validation.rs` — JSON value predicates and the
//! `clean_string_array` normalizer (dedup, trim, order preservation, error paths).
//!
//! Covers the absent-vs-present-null distinction (`None` → fallback, `Some(Null)`
//! → error) that mirrors TS `undefined` vs `null`, every thinking-level enum
//! value, and the rejection branches for non-string / empty / non-array inputs.

use pi_shadow_kernel::types::ThinkingLevel;
use pi_shadow_kernel::validation::{
    clean_string_array, is_finite_number, is_non_empty_string, is_string_array,
    is_thinking_level, parse_thinking_level, THINKING_LEVELS,
};
use serde_json::{json, Value};

#[test]
fn is_finite_number_accepts_numbers() {
    assert!(is_finite_number(&json!(42)));
    assert!(is_finite_number(&json!(2.5)));
    assert!(is_finite_number(&json!(0)));
    assert!(is_finite_number(&json!(-5)));
}

#[test]
fn is_finite_number_rejects_non_numbers() {
    assert!(!is_finite_number(&json!("42")));
    assert!(!is_finite_number(&json!(null)));
    assert!(!is_finite_number(&json!(true)));
    assert!(!is_finite_number(&json!([1])));
}

#[test]
fn is_non_empty_string_truthy_cases() {
    assert!(is_non_empty_string(&json!("x")));
    assert!(is_non_empty_string(&json!("  x  ")));
}

#[test]
fn is_non_empty_string_falsy_cases() {
    assert!(!is_non_empty_string(&json!("")));
    assert!(!is_non_empty_string(&json!("   ")));
    assert!(!is_non_empty_string(&json!(null)));
    assert!(!is_non_empty_string(&json!(42)));
}

#[test]
fn is_string_array_cases() {
    assert!(is_string_array(&json!(["a", "b"])));
    assert!(is_string_array(&json!([])));
    assert!(!is_string_array(&json!(["a", ""])));
    assert!(!is_string_array(&json!(["a", 1])));
    assert!(!is_string_array(&json!("not array")));
    assert!(!is_string_array(&json!(null)));
}

#[test]
fn clean_string_array_absent_uses_fallback() {
    let fallback = vec!["a".to_string(), "b".to_string()];
    assert_eq!(clean_string_array(None, &fallback, "x").unwrap(), fallback);
}

#[test]
fn clean_string_array_dedups_trims_preserves_order() {
    let empty: Vec<String> = Vec::new();
    let v = json!([" b ", "a", "b", "a ", "c"]);
    let out = clean_string_array(Some(&v), &empty, "x").unwrap();
    assert_eq!(out, vec!["b".to_string(), "a".to_string(), "c".to_string()]);
}

#[test]
fn clean_string_array_rejects_non_array() {
    let empty: Vec<String> = Vec::new();
    assert!(clean_string_array(Some(&json!("not array")), &empty, "x").is_err());
    assert!(clean_string_array(Some(&json!(null)), &empty, "x").is_err());
    assert!(clean_string_array(Some(&json!(42)), &empty, "x").is_err());
}

#[test]
fn clean_string_array_rejects_non_string_element() {
    let empty: Vec<String> = Vec::new();
    let v = json!(["a", 1]);
    assert!(clean_string_array(Some(&v), &empty, "x").is_err());
}

#[test]
fn clean_string_array_rejects_empty_string_element() {
    let empty: Vec<String> = Vec::new();
    let v = json!(["a", "  "]);
    assert!(clean_string_array(Some(&v), &empty, "x").is_err());
}

#[test]
fn is_thinking_level_all_valid() {
    for &lvl in THINKING_LEVELS {
        assert!(is_thinking_level(&Value::String(lvl.to_string())));
    }
}

#[test]
fn is_thinking_level_invalid() {
    assert!(!is_thinking_level(&json!("bogus")));
    assert!(!is_thinking_level(&json!(42)));
    assert!(!is_thinking_level(&json!(null)));
}

#[test]
fn parse_thinking_level_all_variants() {
    assert_eq!(parse_thinking_level(&json!("off")), Some(ThinkingLevel::Off));
    assert_eq!(parse_thinking_level(&json!("minimal")), Some(ThinkingLevel::Minimal));
    assert_eq!(parse_thinking_level(&json!("low")), Some(ThinkingLevel::Low));
    assert_eq!(parse_thinking_level(&json!("medium")), Some(ThinkingLevel::Medium));
    assert_eq!(parse_thinking_level(&json!("high")), Some(ThinkingLevel::High));
    assert_eq!(parse_thinking_level(&json!("xhigh")), Some(ThinkingLevel::Xhigh));
    assert_eq!(parse_thinking_level(&json!("max")), Some(ThinkingLevel::Max));
}

#[test]
fn parse_thinking_level_invalid_returns_none() {
    assert_eq!(parse_thinking_level(&json!("bogus")), None);
    assert_eq!(parse_thinking_level(&json!(42)), None);
    assert_eq!(parse_thinking_level(&json!(null)), None);
}
