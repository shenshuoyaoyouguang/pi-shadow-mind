//! Deterministic prefilter and final-response decision — mirror of `src/scheduler.ts`.
//! Pure functions, no I/O. Slot budgeting stays with the caller.

use crate::types::{ShadowDefinition, ShadowTrigger};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub fn extract_tool_names(results: &[Value]) -> HashSet<String> {
    let mut names = HashSet::new();
    for item in results {
        if let Some(obj) = item.as_object() {
            if let Some(name) = obj.get("toolName").and_then(|v| v.as_str()) {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    names.insert(trimmed.to_string());
                }
            }
        }
    }
    names
}

pub fn should_evaluate_heartbeat(names: &HashSet<String>, heartbeat_tools: &[String]) -> bool {
    if names.is_empty() {
        return false;
    }
    if heartbeat_tools.is_empty() {
        return true;
    }
    heartbeat_tools.iter().any(|tool| names.contains(tool))
}

pub fn should_evaluate_final_response(messages: &[Value]) -> bool {
    let last = match messages.last() {
        Some(m) => m,
        None => return false,
    };
    let obj = match last.as_object() {
        Some(o) => o,
        None => return false,
    };
    if obj.get("role").and_then(|v| v.as_str()) != Some("assistant") {
        return false;
    }
    match obj.get("content") {
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Array(blocks)) => blocks.iter().any(|block| {
            let b = block.as_object();
            b.and_then(|o| o.get("type")).and_then(|v| v.as_str()) == Some("text")
                && b.and_then(|o| o.get("text"))
                    .and_then(|v| v.as_str())
                    .is_some_and(|t| !t.trim().is_empty())
        }),
        _ => false,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectCandidatesInput {
    pub shadows: Vec<ShadowDefinition>,
    pub active_shadow_ids: HashSet<String>,
    pub main_model_id: String,
    #[serde(default)]
    pub executed_tools: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectCandidatesOutput {
    pub candidates: Vec<ShadowDefinition>,
    pub disabled: Vec<String>,
    pub model_filtered: Vec<String>,
    pub running_excluded: Vec<String>,
    pub tool_filtered: Vec<String>,
}

pub fn select_candidates(input: &SelectCandidatesInput) -> SelectCandidatesOutput {
    let mut disabled = Vec::new();
    let mut model_filtered = Vec::new();
    let mut running_excluded = Vec::new();
    let mut tool_filtered = Vec::new();
    let executed_set: Option<HashSet<String>> = input
        .executed_tools
        .as_ref()
        .map(|v| v.iter().cloned().collect());
    let mut candidates = Vec::new();
    for shadow in &input.shadows {
        if !shadow.enabled {
            disabled.push(shadow.id.clone());
            continue;
        }
        if !has_trigger(shadow, ShadowTrigger::Heartbeat) {
            continue;
        }
        if input.active_shadow_ids.contains(&shadow.id) {
            running_excluded.push(shadow.id.clone());
            continue;
        }
        if !matches_model(shadow, &input.main_model_id) {
            model_filtered.push(shadow.id.clone());
            continue;
        }
        if !matches_activation_tools(shadow, executed_set.as_ref()) {
            tool_filtered.push(shadow.id.clone());
            continue;
        }
        candidates.push(shadow.clone());
    }
    SelectCandidatesOutput {
        candidates,
        disabled,
        model_filtered,
        running_excluded,
        tool_filtered,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecideFinalResponseInput {
    pub shadows: Vec<ShadowDefinition>,
    pub main_model_id: String,
    #[serde(default)]
    pub can_run_map: Option<HashMap<String, bool>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivatedEntry {
    pub shadow: ShadowDefinition,
    pub roll: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateEntry {
    pub shadow_id: String,
    pub roll: u32,
    pub selected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowActivationDecision {
    pub activated: Vec<ActivatedEntry>,
    pub candidates: Vec<CandidateEntry>,
    pub model_filtered: Vec<String>,
    pub running_excluded: Vec<String>,
    pub round_filtered: Vec<String>,
}

pub fn decide_final_response(input: &DecideFinalResponseInput) -> ShadowActivationDecision {
    let mut model_filtered = Vec::new();
    let mut round_filtered = Vec::new();
    let mut activated: Vec<(ShadowDefinition, u32)> = Vec::new();
    for shadow in &input.shadows {
        if !shadow.enabled || !has_trigger(shadow, ShadowTrigger::FinalResponse) {
            continue;
        }
        if !matches_model(shadow, &input.main_model_id) {
            model_filtered.push(shadow.id.clone());
            continue;
        }
        if let Some(map) = &input.can_run_map {
            if !map.get(&shadow.id).copied().unwrap_or(true) {
                round_filtered.push(shadow.id.clone());
                continue;
            }
        }
        activated.push((shadow.clone(), 0));
    }
    let candidates = activated
        .iter()
        .map(|(s, roll)| CandidateEntry {
            shadow_id: s.id.clone(),
            roll: *roll,
            selected: true,
        })
        .collect();
    let activated_out = activated
        .into_iter()
        .map(|(shadow, roll)| ActivatedEntry { shadow, roll })
        .collect();
    ShadowActivationDecision {
        activated: activated_out,
        candidates,
        model_filtered,
        running_excluded: Vec::new(),
        round_filtered,
    }
}

pub fn matches_model(shadow: &ShadowDefinition, full_model_id: &str) -> bool {
    if shadow.active_for_models.is_empty() {
        return false;
    }
    let mut negatives: Vec<String> = Vec::new();
    let mut positives: Vec<String> = Vec::new();
    for item in &shadow.active_for_models {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('!') {
            let pattern = rest.trim();
            if !pattern.is_empty() {
                negatives.push(pattern.to_string());
            }
        } else {
            positives.push(trimmed.to_string());
        }
    }
    for neg in &negatives {
        if model_pattern_matches(neg, full_model_id) {
            return false;
        }
    }
    if positives.is_empty() {
        return !negatives.is_empty();
    }
    positives
        .iter()
        .any(|pos| model_pattern_matches(pos, full_model_id))
}

pub fn matches_activation_tools(shadow: &ShadowDefinition, executed: Option<&HashSet<String>>) -> bool {
    if shadow.activation_tools.is_empty() {
        return true;
    }
    let executed = match executed {
        Some(e) => e,
        None => return false,
    };
    shadow.activation_tools.iter().any(|tool| executed.contains(tool))
}

fn has_trigger(shadow: &ShadowDefinition, trigger: ShadowTrigger) -> bool {
    shadow.trigger.contains(&trigger)
}

fn model_pattern_matches(pattern: &str, full_model_id: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if pattern == full_model_id {
        return true;
    }
    let model_id = match full_model_id.find('/') {
        Some(i) => &full_model_id[i + 1..],
        None => full_model_id,
    };
    if !pattern.contains('/') && pattern == model_id {
        return true;
    }
    if pattern.contains('*') {
        let re = wildcard_to_regex(pattern);
        if re.is_match(full_model_id) {
            return true;
        }
        if !pattern.contains('/') && re.is_match(model_id) {
            return true;
        }
    }
    false
}

/// Mirror of `wildcardToRegex`: escape `.+^${}()|[]\` (not `*`), turn `*` into
/// `.*`, anchor with `^...$`. Other characters (e.g. `?`, `-`, `/`) stay literal,
/// matching the JS source exactly.
fn wildcard_to_regex(pattern: &str) -> Regex {
    let mut out = String::from("^");
    for c in pattern.chars() {
        match c {
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '*' => out.push_str(".*"),
            _ => out.push(c),
        }
    }
    out.push('$');
    Regex::new(&out).expect("wildcard pattern must compile")
}
