//! Input validation helpers mirroring `src/validation.ts`.
//!
//! These operate on `serde_json::Value` because config/registry parse untyped
//! JSON objects. `Option<&Value>` distinguishes absent (→ fallback) from present
//! `null` (→ error), matching TS `undefined` vs `null`.

use crate::types::ThinkingLevel;
use serde_json::Value;
use std::collections::HashSet;

pub const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

pub fn is_finite_number(value: &Value) -> bool {
    // JSON cannot represent NaN/Infinity, so any JSON number is finite.
    value.as_f64().is_some_and(|n| n.is_finite())
}

pub fn is_non_empty_string(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.trim().is_empty())
}

pub fn is_string_array(value: &Value) -> bool {
    match value {
        Value::Array(arr) => arr.iter().all(is_non_empty_string),
        _ => false,
    }
}

/// Mirrors `cleanStringArray(value, fallback, name)`: `None` (absent) → fallback
/// clone; non-string-array → error; otherwise deduped, trimmed, order-preserved.
pub fn clean_string_array(
    value: Option<&Value>,
    fallback: &[String],
    name: &str,
) -> Result<Vec<String>, String> {
    match value {
        None => Ok(fallback.to_vec()),
        Some(Value::Array(arr)) => {
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for item in arr {
                let raw = item
                    .as_str()
                    .ok_or_else(|| format!("{} must be an array of non-empty strings", name))?;
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return Err(format!("{} must be an array of non-empty strings", name));
                }
                let s = trimmed.to_string();
                if seen.insert(s.clone()) {
                    out.push(s);
                }
            }
            Ok(out)
        }
        Some(_) => Err(format!("{} must be an array of non-empty strings", name)),
    }
}

pub fn is_thinking_level(value: &Value) -> bool {
    value.as_str().is_some_and(|s| THINKING_LEVELS.contains(&s))
}

pub fn parse_thinking_level(value: &Value) -> Option<ThinkingLevel> {
    match value.as_str()? {
        "off" => Some(ThinkingLevel::Off),
        "minimal" => Some(ThinkingLevel::Minimal),
        "low" => Some(ThinkingLevel::Low),
        "medium" => Some(ThinkingLevel::Medium),
        "high" => Some(ThinkingLevel::High),
        "xhigh" => Some(ThinkingLevel::Xhigh),
        "max" => Some(ThinkingLevel::Max),
        _ => None,
    }
}
