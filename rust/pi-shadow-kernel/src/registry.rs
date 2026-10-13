//! Shadow-definition validation/normalization, mirroring the pure half of
//! `src/registry.ts` (`parseShadowMarkdown`). YAML parsing and frontmatter
//! extraction stay in TypeScript; this module receives the already-parsed
//! frontmatter object plus the prompt body and produces a `ShadowDefinition`.

use crate::types::{ShadowDefinition, ShadowTrigger, ThinkingLevel};
use crate::validation::{clean_string_array, is_finite_number, parse_thinking_level};
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

static ID_RE: OnceLock<Regex> = OnceLock::new();
fn id_re() -> &'static Regex {
    ID_RE.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9_-]*$").unwrap())
}

const KNOWN_SHADOW_KEYS: &[&str] = &[
    "id",
    "name",
    "enabled",
    "debug",
    "activation_probability",
    "trigger",
    "active_for_models",
    "run_with_model",
    "thinking_level",
    "timeout_seconds",
    "final_response_rounds",
    "activation_tools",
    "tools",
];

const SHADOW_TRIGGERS: &[&str] = &["heartbeat", "final_response"];

pub fn parse_shadow_definition(
    meta: &Value,
    body: &str,
    file_path: &str,
    fallback_id: &str,
) -> Result<ShadowDefinition, String> {
    let obj = match meta {
        Value::Object(o) => o,
        _ => return Err("frontmatter must be an object".to_string()),
    };

    let id = string_value(obj.get("id"), fallback_id, "id")?;
    if !id_re().is_match(&id) {
        return Err("id must match [a-z0-9][a-z0-9_-]*".to_string());
    }
    let prompt = body.trim().to_string();
    if prompt.is_empty() {
        return Err("shadow prompt body is empty".to_string());
    }

    let name = string_value(obj.get("name"), &id, "name")?;
    let enabled = boolean_value(obj.get("enabled"), true, "enabled")?;
    let debug = boolean_value(obj.get("debug"), false, "debug")?;
    let trigger = trigger_array(obj.get("trigger"), &["heartbeat".to_string()], "trigger")?;
    let active_for_models = clean_string_array(
        obj.get("active_for_models"),
        &["*".to_string()],
        "active_for_models",
    )?;
    let run_with_model = optional_string(obj.get("run_with_model"), "run_with_model")?;
    let thinking_level = optional_thinking(obj.get("thinking_level"))?;
    let timeout_seconds = optional_positive_number(obj.get("timeout_seconds"), "timeout_seconds")?;
    let final_response_rounds =
        optional_non_negative_integer(obj.get("final_response_rounds"), "final_response_rounds")?;
    let activation_tools = clean_string_array(obj.get("activation_tools"), &[], "activation_tools")?;
    let tools = clean_string_array(obj.get("tools"), &[], "tools")?;

    let mut extra_fields = Map::new();
    for (key, val) in obj.iter() {
        if !KNOWN_SHADOW_KEYS.contains(&key.as_str()) {
            extra_fields.insert(key.clone(), val.clone());
        }
    }
    let extra = if extra_fields.is_empty() {
        None
    } else {
        Some(extra_fields)
    };

    Ok(ShadowDefinition {
        id,
        name,
        enabled,
        debug,
        trigger,
        active_for_models,
        run_with_model,
        thinking_level,
        timeout_seconds,
        final_response_rounds,
        activation_tools,
        tools,
        prompt,
        file_path: file_path.to_string(),
        extra_fields: extra,
    })
}

fn string_value(value: Option<&Value>, fallback: &str, name: &str) -> Result<String, String> {
    match value {
        None => Ok(fallback.to_string()),
        Some(v) => {
            let s = v
                .as_str()
                .ok_or_else(|| format!("{} must be a non-empty string", name))?;
            if s.trim().is_empty() {
                return Err(format!("{} must be a non-empty string", name));
            }
            Ok(s.trim().to_string())
        }
    }
}

fn optional_string(value: Option<&Value>, name: &str) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(v) => Ok(Some(string_value(Some(v), "", name)?)),
    }
}

fn boolean_value(value: Option<&Value>, fallback: bool, name: &str) -> Result<bool, String> {
    match value {
        None => Ok(fallback),
        Some(Value::Bool(b)) => Ok(b),
        _ => Err(format!("{} must be boolean", name)),
    }
}

fn optional_positive_number(value: Option<&Value>, name: &str) -> Result<Option<f64>, String> {
    match value {
        None => Ok(None),
        Some(v) => {
            let f = v
                .as_f64()
                .ok_or_else(|| format!("{} must be positive", name))?;
            if !is_finite_number(v) || f <= 0.0 {
                return Err(format!("{} must be positive", name));
            }
            Ok(Some(f))
        }
    }
}

fn optional_non_negative_integer(value: Option<&Value>, name: &str) -> Result<Option<u32>, String> {
    match value {
        None => Ok(None),
        Some(v) => {
            let f = v
                .as_f64()
                .ok_or_else(|| format!("{} must be a non-negative integer", name))?;
            if !is_finite_number(v) || f.fract() != 0.0 || f < 0.0 {
                return Err(format!("{} must be a non-negative integer", name));
            }
            Ok(Some(f as u32))
        }
    }
}

fn trigger_array(
    value: Option<&Value>,
    fallback: &[String],
    name: &str,
) -> Result<Vec<ShadowTrigger>, String> {
    let values: Option<Value> = match value {
        None => None,
        Some(Value::String(s)) => Some(Value::Array(vec![Value::String(s.clone())])),
        Some(v) => Some(v.clone()),
    };
    let items = clean_string_array(values.as_ref(), fallback, name)?;
    for item in &items {
        if !SHADOW_TRIGGERS.contains(&item.as_str()) {
            return Err(format!("{} contains invalid trigger: {}", name, items.join(", ")));
        }
    }
    Ok(items.iter().map(|s| parse_trigger(s)).collect())
}

fn parse_trigger(s: &str) -> ShadowTrigger {
    match s {
        "heartbeat" => ShadowTrigger::Heartbeat,
        _ => ShadowTrigger::FinalResponse,
    }
}

fn optional_thinking(value: Option<&Value>) -> Result<Option<ThinkingLevel>, String> {
    match value {
        None => Ok(None),
        Some(v) => parse_thinking_level(v)
            .ok_or_else(|| "thinking_level is invalid".to_string())
            .map(Some),
    }
}
