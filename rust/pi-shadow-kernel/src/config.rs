//! Config parse/serialize, mirroring the pure halves of `src/config.ts`.
//! `parse_config` takes raw snake_case JSON (the config file); `serialize_config`
//! emits snake_case JSON. The `ConfigStore` fs class stays in TS.

use crate::types::{ShadowConfig, ThinkingLevel};
use crate::validation::{clean_string_array, is_finite_number, parse_thinking_level};
use serde_json::{Map, Value};

const DEFAULT_EXCLUDED_EXTENSIONS: &[&str] = &["pi-experiencev2"];

const KNOWN_CONFIG_KEYS: &[&str] = &[
    "max_parallel_shadows",
    "default_shadow_timeout_seconds",
    "headless_drain_timeout_seconds",
    "result_batch_window_ms",
    "heartbeat_tools",
    "excluded_extensions",
    "default_shadow_model",
    "gatekeeper_model",
    "default_thinking_level",
];

pub fn default_config() -> ShadowConfig {
    ShadowConfig {
        heartbeat_tools: Vec::new(),
        max_parallel_shadows: 2,
        default_shadow_timeout_seconds: 300.0,
        headless_drain_timeout_seconds: 120.0,
        result_batch_window_ms: 400,
        excluded_extensions: DEFAULT_EXCLUDED_EXTENSIONS
            .iter()
            .map(|s| s.to_string())
            .collect(),
        default_shadow_model: None,
        gatekeeper_model: None,
        default_thinking_level: ThinkingLevel::Low,
        extra_fields: None,
    }
}

pub fn parse_config(raw: &str) -> Result<ShadowConfig, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("config must be a JSON object: {}", e))?;
    let obj = match value {
        Value::Object(o) => o,
        _ => return Err("config must be a JSON object".to_string()),
    };
    let defaults = default_config();
    let heartbeat_tools = clean_string_array(
        obj.get("heartbeat_tools"),
        &defaults.heartbeat_tools,
        "heartbeat_tools",
    )?;
    let parallel = positive_integer(
        obj.get("max_parallel_shadows"),
        defaults.max_parallel_shadows as f64,
        "max_parallel_shadows",
    )? as u32;
    let timeout = positive_number(
        obj.get("default_shadow_timeout_seconds"),
        defaults.default_shadow_timeout_seconds,
        "default_shadow_timeout_seconds",
    )?;
    let drain_timeout = positive_number(
        obj.get("headless_drain_timeout_seconds"),
        defaults.headless_drain_timeout_seconds,
        "headless_drain_timeout_seconds",
    )?;
    let window_ms = non_negative_integer(
        obj.get("result_batch_window_ms"),
        defaults.result_batch_window_ms,
        "result_batch_window_ms",
    )?;
    let excluded_extensions = clean_string_array(
        obj.get("excluded_extensions"),
        &defaults.excluded_extensions,
        "excluded_extensions",
    )?;
    let model = optional_non_empty_string(obj.get("default_shadow_model"), "default_shadow_model")?;
    let gatekeeper = optional_non_empty_string(obj.get("gatekeeper_model"), "gatekeeper_model")?;
    let thinking = match obj.get("default_thinking_level") {
        None | Some(Value::Null) => defaults.default_thinking_level,
        Some(v) => parse_thinking_level(v)
            .ok_or_else(|| "default_thinking_level is invalid".to_string())?,
    };
    let mut extra_fields = Map::new();
    for (key, val) in obj.iter() {
        if !KNOWN_CONFIG_KEYS.contains(&key.as_str()) {
            extra_fields.insert(key.clone(), val.clone());
        }
    }
    let extra = if extra_fields.is_empty() {
        None
    } else {
        Some(extra_fields)
    };
    Ok(ShadowConfig {
        heartbeat_tools,
        max_parallel_shadows: parallel,
        default_shadow_timeout_seconds: timeout,
        headless_drain_timeout_seconds: drain_timeout,
        result_batch_window_ms: window_ms,
        excluded_extensions,
        default_shadow_model: model,
        gatekeeper_model: gatekeeper,
        default_thinking_level: thinking,
        extra_fields: extra,
    })
}

pub fn serialize_config(config: &ShadowConfig) -> String {
    let mut root = Map::new();
    if !config.heartbeat_tools.is_empty() {
        root.insert(
            "heartbeat_tools".to_string(),
            Value::Array(
                config
                    .heartbeat_tools
                    .iter()
                    .map(|s| Value::String(s.clone()))
                    .collect(),
            ),
        );
    }
    root.insert(
        "max_parallel_shadows".to_string(),
        Value::from(config.max_parallel_shadows),
    );
    root.insert(
        "default_shadow_timeout_seconds".to_string(),
        num(config.default_shadow_timeout_seconds),
    );
    root.insert(
        "headless_drain_timeout_seconds".to_string(),
        num(config.headless_drain_timeout_seconds),
    );
    root.insert(
        "result_batch_window_ms".to_string(),
        Value::from(config.result_batch_window_ms),
    );
    root.insert(
        "excluded_extensions".to_string(),
        Value::Array(
            config
                .excluded_extensions
                .iter()
                .map(|s| Value::String(s.clone()))
                .collect(),
        ),
    );
    if let Some(m) = &config.default_shadow_model {
        root.insert("default_shadow_model".to_string(), Value::String(m.clone()));
    }
    if let Some(g) = &config.gatekeeper_model {
        root.insert("gatekeeper_model".to_string(), Value::String(g.clone()));
    }
    root.insert(
        "default_thinking_level".to_string(),
        serde_json::json!(config.default_thinking_level),
    );
    if let Some(extra) = &config.extra_fields {
        for (k, v) in extra.iter() {
            root.insert(k.clone(), v.clone());
        }
    }
    let mut out = serde_json::to_string_pretty(&Value::Object(root)).unwrap();
    out.push('\n');
    out
}

/// Serialize an f64 like JS `JSON.stringify` — integer-valued numbers print
/// without a trailing `.0` (e.g. `300`, not `300.0`).
fn num(v: f64) -> Value {
    if v.fract() == 0.0 && v.is_finite() && v.abs() < 9_007_199_254_740_992.0 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

fn positive_number(value: Option<&Value>, fallback: f64, name: &str) -> Result<f64, String> {
    match value {
        None => Ok(fallback),
        Some(v) => {
            let f = v
                .as_f64()
                .ok_or_else(|| format!("{} must be positive", name))?;
            if !is_finite_number(v) || f <= 0.0 {
                return Err(format!("{} must be positive", name));
            }
            Ok(f)
        }
    }
}

fn positive_integer(value: Option<&Value>, fallback: f64, name: &str) -> Result<f64, String> {
    let parsed = positive_number(value, fallback, name)?;
    if parsed.fract() != 0.0 {
        return Err(format!("{} must be an integer", name));
    }
    Ok(parsed)
}

fn non_negative_integer(value: Option<&Value>, fallback: u32, name: &str) -> Result<u32, String> {
    match value {
        None => Ok(fallback),
        Some(v) => {
            let f = v
                .as_f64()
                .ok_or_else(|| format!("{} must be a non-negative integer", name))?;
            if !is_finite_number(v) || f.fract() != 0.0 || f < 0.0 {
                return Err(format!("{} must be a non-negative integer", name));
            }
            Ok(f as u32)
        }
    }
}

fn optional_non_empty_string(value: Option<&Value>, name: &str) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(v) => {
            let s = v
                .as_str()
                .ok_or_else(|| format!("{} must be a non-empty string", name))?;
            if s.trim().is_empty() {
                return Err(format!("{} must be a non-empty string", name));
            }
            Ok(Some(s.trim().to_string()))
        }
    }
}
