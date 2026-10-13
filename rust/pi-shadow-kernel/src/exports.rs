//! wasm-bindgen exports: a JSON-string boundary over the pure kernel.
//!
//! Every function takes JSON (or primitives) and returns JSON / strings / bools.
//! The TypeScript wrappers in `src/wasm-kernel.ts` (de)serialize at the seam, so
//! the existing TS module signatures stay unchanged for their callers.

use crate::scheduler;
use crate::summaries;
use crate::trajectory;
use crate::types::{ShadowConfig, ShadowDefinition, ShadowUsage};
use crate::{config, gatekeeper, protocol, registry, usage, validation};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---- scheduler ----

#[wasm_bindgen]
pub fn schedulerExtractToolNames(input: &str) -> Result<String, String> {
    let results: Vec<Value> = serde_json::from_str(input).map_err(err)?;
    let names: Vec<String> = scheduler::extract_tool_names(&results).into_iter().collect();
    serde_json::to_string(&names).map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatInput {
    tool_names: Vec<String>,
    heartbeat_tools: Vec<String>,
}

#[wasm_bindgen]
pub fn schedulerShouldEvaluateHeartbeat(input: &str) -> Result<bool, String> {
    let i: HeartbeatInput = serde_json::from_str(input).map_err(err)?;
    let names: HashSet<String> = i.tool_names.into_iter().collect();
    Ok(scheduler::should_evaluate_heartbeat(&names, &i.heartbeat_tools))
}

#[wasm_bindgen]
pub fn schedulerShouldEvaluateFinalResponse(input: &str) -> Result<bool, String> {
    let messages: Vec<Value> = serde_json::from_str(input).map_err(err)?;
    Ok(scheduler::should_evaluate_final_response(&messages))
}

#[wasm_bindgen]
pub fn schedulerSelectCandidates(input: &str) -> Result<String, String> {
    let i: scheduler::SelectCandidatesInput = serde_json::from_str(input).map_err(err)?;
    serde_json::to_string(&scheduler::select_candidates(&i)).map_err(err)
}

#[wasm_bindgen]
pub fn schedulerDecideFinalResponse(input: &str) -> Result<String, String> {
    let i: scheduler::DecideFinalResponseInput = serde_json::from_str(input).map_err(err)?;
    serde_json::to_string(&scheduler::decide_final_response(&i)).map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchesModelInput {
    shadow: ShadowDefinition,
    main_model_id: String,
}

#[wasm_bindgen]
pub fn schedulerMatchesModel(input: &str) -> Result<bool, String> {
    let i: MatchesModelInput = serde_json::from_str(input).map_err(err)?;
    Ok(scheduler::matches_model(&i.shadow, &i.main_model_id))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchesActivationToolsInput {
    shadow: ShadowDefinition,
    #[serde(default)]
    executed_tools: Option<Vec<String>>,
}

#[wasm_bindgen]
pub fn schedulerMatchesActivationTools(input: &str) -> Result<bool, String> {
    let i: MatchesActivationToolsInput = serde_json::from_str(input).map_err(err)?;
    let set: Option<HashSet<String>> = i.executed_tools.map(|v| v.into_iter().collect());
    Ok(scheduler::matches_activation_tools(&i.shadow, set.as_ref()))
}

// ---- usage ----

#[wasm_bindgen]
pub fn usageZeroUsage() -> String {
    serde_json::to_string(&usage::zero_usage()).unwrap()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsagePair {
    left: ShadowUsage,
    right: ShadowUsage,
}

#[wasm_bindgen]
pub fn usageAdd(input: &str) -> Result<String, String> {
    let i: UsagePair = serde_json::from_str(input).map_err(err)?;
    serde_json::to_string(&usage::add_usage(&i.left, &i.right)).map_err(err)
}

#[wasm_bindgen]
pub fn usageFormatTokens(tokens: f64) -> String {
    usage::format_usage_tokens(tokens as u64)
}

#[wasm_bindgen]
pub fn usageFormatCost(cost: f64) -> String {
    usage::format_usage_cost(cost)
}

#[wasm_bindgen]
pub fn usageFormatSummary(input: &str) -> Result<String, String> {
    let u: ShadowUsage = serde_json::from_str(input).map_err(err)?;
    Ok(usage::format_usage_summary(&u))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageDetailInput {
    scope: String,
    usage: ShadowUsage,
}

#[wasm_bindgen]
pub fn usageFormatDetail(input: &str) -> Result<String, String> {
    let i: UsageDetailInput = serde_json::from_str(input).map_err(err)?;
    Ok(usage::format_usage_detail(&i.scope, &i.usage))
}

// ---- validation ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanStringArrayInput {
    #[serde(default)]
    value: Option<Value>,
    fallback: Vec<String>,
    name: String,
}

#[wasm_bindgen]
pub fn validationCleanStringArray(input: &str) -> Result<String, String> {
    let i: CleanStringArrayInput = serde_json::from_str(input).map_err(err)?;
    let out = validation::clean_string_array(i.value.as_ref(), &i.fallback, &i.name)?;
    serde_json::to_string(&out).map_err(err)
}

#[wasm_bindgen]
pub fn validationIsThinkingLevel(input: &str) -> bool {
    serde_json::from_str::<Value>(input)
        .map(|v| validation::is_thinking_level(&v))
        .unwrap_or(false)
}

#[wasm_bindgen]
pub fn validationIsStringArray(input: &str) -> bool {
    serde_json::from_str::<Value>(input)
        .map(|v| validation::is_string_array(&v))
        .unwrap_or(false)
}

// ---- summaries ----

#[wasm_bindgen]
pub fn summariesSummarizeToolResult(input: &str) -> Result<String, String> {
    let result: Value = serde_json::from_str(input).map_err(err)?;
    Ok(summaries::summarize_tool_result(&result))
}

// ---- trajectory ----

#[wasm_bindgen]
pub fn trajectorySerialize(input: &str) -> Result<String, String> {
    let messages: Vec<Value> = serde_json::from_str(input).map_err(err)?;
    Ok(trajectory::serialize_trajectory(&messages))
}

// ---- protocol ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildShadowRequestInput {
    trajectory: String,
    shadow: ShadowDefinition,
    #[serde(default)]
    brief: Option<String>,
}

#[wasm_bindgen]
pub fn protocolBuildShadowRequest(input: &str) -> Result<String, String> {
    let i: BuildShadowRequestInput = serde_json::from_str(input).map_err(err)?;
    Ok(protocol::build_shadow_request(
        &i.trajectory,
        &i.shadow,
        i.brief.as_deref(),
    ))
}

// ---- config ----

#[wasm_bindgen]
pub fn configParse(input: &str) -> Result<String, String> {
    let cfg = config::parse_config(input)?;
    serde_json::to_string(&cfg).map_err(err)
}

#[wasm_bindgen]
pub fn configSerialize(input: &str) -> Result<String, String> {
    let cfg: ShadowConfig = serde_json::from_str(input).map_err(err)?;
    Ok(config::serialize_config(&cfg))
}

// ---- registry ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseShadowDefinitionInput {
    meta: Value,
    body: String,
    file_path: String,
    fallback_id: String,
}

#[wasm_bindgen]
pub fn registryParseShadowDefinition(input: &str) -> Result<String, String> {
    let i: ParseShadowDefinitionInput = serde_json::from_str(input).map_err(err)?;
    let def = registry::parse_shadow_definition(&i.meta, &i.body, &i.file_path, &i.fallback_id)?;
    serde_json::to_string(&def).map_err(err)
}

// ---- gatekeeper ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildPromptInput {
    candidates: Vec<ShadowDefinition>,
    trajectory: String,
}

#[wasm_bindgen]
pub fn gatekeeperBuildPrompt(input: &str) -> Result<String, String> {
    let i: BuildPromptInput = serde_json::from_str(input).map_err(err)?;
    serde_json::to_string(&gatekeeper::build_gatekeeper_prompt(&i.candidates, &i.trajectory))
        .map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FitTrajectoryInput {
    trajectory: String,
    context_window_chars: usize,
    #[serde(default)]
    reserved_chars: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FitTrajectoryOutput {
    text: String,
    truncated: bool,
}

#[wasm_bindgen]
pub fn gatekeeperFitTrajectory(input: &str) -> Result<String, String> {
    let i: FitTrajectoryInput = serde_json::from_str(input).map_err(err)?;
    let (text, truncated) =
        gatekeeper::fit_trajectory(&i.trajectory, i.context_window_chars, i.reserved_chars);
    serde_json::to_string(&FitTrajectoryOutput { text, truncated }).map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseReplyInput {
    text: String,
    candidate_ids: Vec<String>,
}

#[wasm_bindgen]
pub fn gatekeeperParseReply(input: &str) -> Result<String, String> {
    let i: ParseReplyInput = serde_json::from_str(input).map_err(err)?;
    let ids: HashSet<String> = i.candidate_ids.into_iter().collect();
    let activations = gatekeeper::parse_gatekeeper_reply(&i.text, &ids)?;
    serde_json::to_string(&activations).map_err(err)
}
