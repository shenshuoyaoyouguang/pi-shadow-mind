//! Domain types mirroring `src/types.ts` and `src/usage.ts`.
//!
//! All structs use `rename_all = "camelCase"` so the WASM JSON boundary accepts
//! and returns the same shape the TypeScript domain objects use, keeping the TS
//! wrappers trivial (`JSON.stringify` in, `JSON.parse` out).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ShadowTrigger {
    #[serde(rename = "heartbeat")]
    Heartbeat,
    #[serde(rename = "final_response")]
    FinalResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowConfig {
    pub heartbeat_tools: Vec<String>,
    pub max_parallel_shadows: u32,
    pub default_shadow_timeout_seconds: f64,
    pub headless_drain_timeout_seconds: f64,
    pub result_batch_window_ms: u32,
    pub excluded_extensions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_shadow_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gatekeeper_model: Option<String>,
    pub default_thinking_level: ThinkingLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_fields: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowDefinition {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default)]
    pub debug: bool,
    pub trigger: Vec<ShadowTrigger>,
    pub active_for_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_with_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_response_rounds: Option<u32>,
    #[serde(default)]
    pub activation_tools: Vec<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    pub prompt: String,
    pub file_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_fields: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowUsageCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowUsage {
    pub requests: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total_tokens: u64,
    pub cost: ShadowUsageCost,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReport {
    pub shadow_id: String,
    pub shadow_name: String,
    pub content: String,
    pub epoch: u32,
    pub run_id: String,
}
