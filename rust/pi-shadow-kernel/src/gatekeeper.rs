//! Pure half of `src/gatekeeper.ts`: prompt construction, trajectory fitting,
//! and reply parsing. The LLM call (`runGatekeeper`) and auth hydration stay in
//! TypeScript — they are thin wrappers over `pi-ai` with no portable logic.

use crate::types::ShadowDefinition;
use crate::util::{flatten_ws, utf16_len, utf16_slice_start};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;

pub const GATEKEEPER_BRIEF_CHARS: usize = 400;
const OMISSION_MARKER: &str = "[...earlier trajectory omitted...]";

static USER_START_RE: OnceLock<Regex> = OnceLock::new();
fn user_start_re() -> &'static Regex {
    USER_START_RE.get_or_init(|| Regex::new(r"(?i)^USER:").unwrap())
}

static SEGMENT_START_RE: OnceLock<Regex> = OnceLock::new();
fn segment_start_re() -> &'static Regex {
    SEGMENT_START_RE.get_or_init(|| Regex::new(r"(?i)^(USER|MAIN|TOOL RESULT|TOOL):").unwrap())
}

static FENCED_RE: OnceLock<Regex> = OnceLock::new();
fn fenced_re() -> &'static Regex {
    FENCED_RE.get_or_init(|| Regex::new(r"```(?:json)?\s*([\s\S]*?)```").unwrap())
}

const SYSTEM_PROMPT: &str = "You are the Shadow Mind dispatcher. You decide which persistent Shadow Minds should be woken for the current main-agent turn.\nYou receive a candidate list (id | name | responsibility) and a sanitized trajectory of the main agent's recent activity.\nRelevance means the trajectory touches the candidate's responsibility with something concrete to check or do. Routine chatter, trivial edits, and unrelated work are NOT relevant.\nWhen in doubt, do not activate. Respond with ONLY a JSON object, no prose, no code fences:\n{\"activations\":[{\"id\":\"<candidate id>\",\"brief\":\"<one sentence, in the trajectory's language, telling this Shadow what to focus on>\"}]}\nUse an empty list when no candidate is relevant.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatekeeperPrompt {
    pub system_prompt: String,
    pub user_message: String,
    pub candidate_summaries: String,
}

pub fn build_gatekeeper_prompt(
    candidates: &[ShadowDefinition],
    trajectory: &str,
) -> GatekeeperPrompt {
    let list: Vec<String> = candidates
        .iter()
        .map(|s| {
            let brief = utf16_slice_start(&flatten_ws(&s.prompt), GATEKEEPER_BRIEF_CHARS);
            format!("- {} | {} | {}", s.id, s.name, brief)
        })
        .collect();
    let candidate_summaries = if list.is_empty() {
        "(none)".to_string()
    } else {
        list.join("\n")
    };
    let user_message = format!(
        "Candidates:\n{}\n\nTrajectory:\n{}\n\nDecide which candidates are relevant to this trajectory and respond with the JSON object.",
        candidate_summaries, trajectory
    );
    GatekeeperPrompt {
        system_prompt: SYSTEM_PROMPT.to_string(),
        user_message,
        candidate_summaries,
    }
}

pub fn fit_trajectory(trajectory: &str, context_window_chars: usize, reserved_chars: usize) -> (String, bool) {
    let budget = context_window_chars.saturating_sub(reserved_chars);
    if budget == 0 {
        return (String::new(), true);
    }
    if utf16_len(trajectory) <= budget {
        return (trajectory.to_string(), false);
    }
    let lines: Vec<&str> = trajectory.split('\n').collect();
    let user_start = lines.iter().position(|l| user_start_re().is_match(l));
    let head_end: usize = match user_start {
        None => 0,
        Some(us) => match lines
            .iter()
            .enumerate()
            .position(|(i, l)| i > us && segment_start_re().is_match(l))
        {
            Some(he) => he,
            None => lines.len(),
        },
    };
    let mut head_lines: Vec<String> = if head_end > 0 {
        lines[..head_end].iter().map(|s| s.to_string()).collect()
    } else {
        Vec::new()
    };
    let mut head_chars = utf16_len(&head_lines.join("\n"));
    if head_chars > budget {
        let head_text = head_lines.join("\n");
        let mut kept = String::new();
        let mut units = 0usize;
        let limit = budget.saturating_sub(1);
        for c in head_text.chars() {
            let cu = if (c as u32) > 0xFFFF { 2 } else { 1 };
            if units + cu > limit {
                break;
            }
            kept.push(c);
            units += cu;
        }
        let capped = format!("{}…", kept);
        head_chars = utf16_len(&capped);
        head_lines = vec![capped];
    }
    let tail_budget = budget.saturating_sub(head_chars);
    let mut tail_lines: Vec<String> = Vec::new();
    let mut tail_chars = 0usize;
    let mut index = lines.len() as i64 - 1;
    while index >= head_end as i64 {
        let line = lines[index as usize];
        let line_len = utf16_len(line);
        if tail_chars + line_len + 1 > tail_budget {
            break;
        }
        tail_lines.insert(0, line.to_string());
        tail_chars += line_len + 1;
        index -= 1;
    }
    let mut all = head_lines;
    all.push(OMISSION_MARKER.to_string());
    all.extend(tail_lines);
    (all.join("\n"), true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatekeeperActivation {
    pub id: String,
    pub brief: String,
}

pub fn parse_gatekeeper_reply(
    text: &str,
    candidate_ids: &HashSet<String>,
) -> Result<Vec<GatekeeperActivation>, String> {
    let parsed = extract_json(text)?;
    let activations_val = parsed
        .get("activations")
        .ok_or_else(|| "gatekeeper reply has no activations array".to_string())?;
    let arr = activations_val
        .as_array()
        .ok_or_else(|| "gatekeeper reply has no activations array".to_string())?;
    let mut seen = HashSet::new();
    let mut activations = Vec::new();
    for entry in arr {
        let obj = match entry.as_object() {
            Some(o) => o,
            None => continue,
        };
        let id = match obj.get("id").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => continue,
        };
        if !candidate_ids.contains(id) || seen.contains(id) {
            continue;
        }
        seen.insert(id.to_string());
        let brief = obj
            .get("brief")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        activations.push(GatekeeperActivation {
            id: id.to_string(),
            brief,
        });
    }
    Ok(activations)
}

fn extract_json(text: &str) -> Result<Value, String> {
    let source = match fenced_re().captures(text) {
        Some(caps) => caps[1].trim().to_string(),
        None => text.trim().to_string(),
    };
    if let Ok(v) = serde_json::from_str::<Value>(&source) {
        return Ok(v);
    }
    let start = match source.find('{') {
        Some(i) => i,
        None => return Err("no JSON object in gatekeeper reply".to_string()),
    };
    let bytes = source.as_bytes();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut i = start;
    while i < source.len() {
        let ch = bytes[i] as char;
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
        } else if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return serde_json::from_str(&source[start..=i])
                    .map_err(|_| "no JSON object in gatekeeper reply".to_string());
            }
        }
        i += 1;
    }
    Err("no JSON object in gatekeeper reply".to_string())
}
