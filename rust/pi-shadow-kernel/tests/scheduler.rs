//! Behavior-equivalence tests mirroring `test/scheduler.test.ts`.

use pi_shadow_kernel::scheduler::{
    decide_final_response, extract_tool_names, matches_activation_tools, matches_model,
    select_candidates, should_evaluate_final_response, should_evaluate_heartbeat,
    DecideFinalResponseInput, SelectCandidatesInput,
};
use pi_shadow_kernel::types::{ShadowDefinition, ShadowTrigger};
use serde_json::json;
use std::collections::HashSet;

fn shadow(id: &str, trigger: Vec<ShadowTrigger>, activation_tools: Vec<&str>) -> ShadowDefinition {
    ShadowDefinition {
        id: id.to_string(),
        name: id.to_string(),
        enabled: true,
        debug: false,
        trigger,
        active_for_models: vec!["openai/gpt".to_string()],
        run_with_model: None,
        thinking_level: None,
        timeout_seconds: None,
        final_response_rounds: None,
        activation_tools: activation_tools.into_iter().map(String::from).collect(),
        tools: Vec::new(),
        prompt: id.to_string(),
        file_path: format!("{}.md", id),
        extra_fields: None,
    }
}

fn with_models(mut s: ShadowDefinition, models: Vec<&str>) -> ShadowDefinition {
    s.active_for_models = models.into_iter().map(String::from).collect();
    s
}

fn hb() -> Vec<ShadowTrigger> {
    vec![ShadowTrigger::Heartbeat]
}
fn fr() -> Vec<ShadowTrigger> {
    vec![ShadowTrigger::FinalResponse]
}

#[test]
fn heartbeat_suppresses_pure_turns() {
    let names = HashSet::new();
    assert!(!should_evaluate_heartbeat(&names, &[]));
}

#[test]
fn heartbeat_allows_tool_work() {
    let names: HashSet<String> = ["read"].into_iter().map(String::from).collect();
    assert!(should_evaluate_heartbeat(&names, &[]));
}

#[test]
fn heartbeat_respects_filter() {
    let read: HashSet<String> = ["read"].into_iter().map(String::from).collect();
    assert!(!should_evaluate_heartbeat(&read, &["bash".into(), "write".into()]));
    let bash: HashSet<String> = ["bash"].into_iter().map(String::from).collect();
    assert!(should_evaluate_heartbeat(&bash, &["bash".into(), "write".into()]));
}

#[test]
fn extract_tool_names_trims_and_dedups() {
    let results = vec![
        json!({ "toolName": "bash" }),
        json!({ "toolName": " edit " }),
        json!(null),
        json!({}),
        json!({ "toolName": "" }),
    ];
    let names: HashSet<String> = extract_tool_names(&results).into_iter().collect();
    let expected: HashSet<String> = ["bash", "edit"].into_iter().map(String::from).collect();
    assert_eq!(names, expected);
}

#[test]
fn matches_activation_tools_empty_allows_all() {
    let s = shadow("s", hb(), vec![]);
    assert!(matches_activation_tools(&s, Some(&["read".into()].into_iter().collect())));
    assert!(matches_activation_tools(&s, None));
}

#[test]
fn matches_activation_tools_requires_intersection() {
    let s = shadow("s", hb(), vec!["bash", "edit", "write"]);
    assert!(!matches_activation_tools(&s, Some(&["read".into()].into_iter().collect())));
    assert!(matches_activation_tools(
        &s,
        Some(&["read".into(), "edit".into()].into_iter().collect()),
    ));
}

#[test]
fn final_response_accepts_assistant_text() {
    let msgs = vec![
        json!({ "role": "user", "content": "task" }),
        json!({ "role": "assistant", "content": [{ "type": "text", "text": "Done." }] }),
    ];
    assert!(should_evaluate_final_response(&msgs));
}

#[test]
fn final_response_rejects_non_text_endings() {
    assert!(!should_evaluate_final_response(&[json!({
        "role": "assistant", "content": [{ "type": "toolCall", "name": "read" }]
    })]));
    assert!(!should_evaluate_final_response(&[json!({
        "role": "assistant", "content": [{ "type": "text", "text": "  " }]
    })]));
    assert!(!should_evaluate_final_response(&[]));
}

#[test]
fn matches_model_wildcard_star() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["*"]);
    assert!(matches_model(&s, "openai-codex/gpt-6-astra"));
    assert!(matches_model(&s, "anthropic/claude-3-7-sonnet"));
}

#[test]
fn matches_model_exact_full_id() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["openai-codex/gpt-6-astra"]);
    assert!(matches_model(&s, "openai-codex/gpt-6-astra"));
    assert!(!matches_model(&s, "openai-codex/gpt-5.5"));
    assert!(!matches_model(&s, "anthropic/claude-3-7-sonnet"));
}

#[test]
fn matches_model_short_name() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["gpt-6-astra"]);
    assert!(matches_model(&s, "openai-codex/gpt-6-astra"));
    assert!(matches_model(&s, "custom-provider/gpt-6-astra"));
    assert!(!matches_model(&s, "openai-codex/gpt-5.5"));
}

#[test]
fn matches_model_wildcard_pattern() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["anthropic/*"]);
    assert!(matches_model(&s, "anthropic/claude-3-7-sonnet"));
    assert!(!matches_model(&s, "openai-codex/gpt-6-astra"));
}

#[test]
fn matches_model_exclude_short_name() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["*", "!gpt-6-astra"]);
    assert!(!matches_model(&s, "openai-codex/gpt-6-astra"));
    assert!(matches_model(&s, "anthropic/claude-3-7-sonnet"));
    assert!(matches_model(&s, "deepseek/deepseek-chat"));
}

#[test]
fn matches_model_exclude_full_id() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["*", "!openai-codex/gpt-6-astra"]);
    assert!(!matches_model(&s, "openai-codex/gpt-6-astra"));
    assert!(matches_model(&s, "other-provider/gpt-6-astra"));
    assert!(matches_model(&s, "openai-codex/gpt-5.5"));
}

#[test]
fn matches_model_pure_exclusion() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["!gpt-6-astra"]);
    assert!(!matches_model(&s, "openai-codex/gpt-6-astra"));
    assert!(matches_model(&s, "anthropic/claude-3-7-sonnet"));
}

#[test]
fn matches_model_wildcard_exclusion() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["*", "!*gpt*"]);
    assert!(!matches_model(&s, "openai-codex/gpt-6-astra"));
    assert!(!matches_model(&s, "openai/gpt-4o"));
    assert!(matches_model(&s, "anthropic/claude-3-7-sonnet"));
}

#[test]
fn matches_model_empty_and_blank_entries() {
    let empty = with_models(shadow("s", hb(), vec![]), vec![]);
    assert!(!matches_model(&empty, "openai-codex/gpt-6-aBstra"));
    let blank = with_models(shadow("s", hb(), vec![]), vec!["*", "! ", " "]);
    assert!(matches_model(&blank, "openai-codex/gpt-6-astra"));
}

fn base(id: &str) -> ShadowDefinition {
    ShadowDefinition {
        id: id.to_string(),
        name: "n".to_string(),
        prompt: "p".to_string(),
        file_path: "f".to_string(),
        enabled: true,
        debug: false,
        trigger: hb(),
        active_for_models: vec!["*".to_string()],
        activation_tools: Vec::new(),
        tools: Vec::new(),
        run_with_model: None,
        thinking_level: None,
        timeout_seconds: None,
        final_response_rounds: None,
        extra_fields: None,
    }
}

fn ids(shadows: &[ShadowDefinition]) -> Vec<String> {
    shadows.iter().map(|s| s.id.clone()).collect()
}

#[test]
fn select_candidates_keeps_matching() {
    let shadows = vec![
        base("a"),
        { let mut s = base("b"); s.enabled = false; s },
        with_models(base("c"), vec!["m/1"]),
    ];
    let input = SelectCandidatesInput {
        shadows,
        active_shadow_ids: ["a"].into_iter().map(String::from).collect(),
        main_model_id: "m/1".to_string(),
        executed_tools: None,
    };
    let out = select_candidates(&input);
    assert_eq!(ids(&out.candidates), vec!["c".to_string()]);
    assert_eq!(out.running_excluded, vec!["a".to_string()]);
    assert_eq!(out.disabled, vec!["b".to_string()]);
    assert!(out.model_filtered.is_empty());
}

#[test]
fn select_candidates_separate_buckets() {
    let shadows = vec![
        { let mut s = base("off"); s.enabled = false; s },
        with_models(base("wrongmodel"), vec!["other/1"]),
    ];
    let input = SelectCandidatesInput {
        shadows,
        active_shadow_ids: HashSet::new(),
        main_model_id: "m/1".to_string(),
        executed_tools: None,
    };
    let out = select_candidates(&input);
    assert_eq!(out.disabled, vec!["off".to_string()]);
    assert_eq!(out.model_filtered, vec!["wrongmodel".to_string()]);
}

#[test]
fn select_candidates_returns_everything() {
    let input = SelectCandidatesInput {
        shadows: vec![base("x")],
        active_shadow_ids: HashSet::new(),
        main_model_id: "m/1".to_string(),
        executed_tools: None,
    };
    let out = select_candidates(&input);
    assert_eq!(ids(&out.candidates), vec!["x".to_string()]);
}

#[test]
fn select_candidates_tool_filter() {
    let writer = shadow("writer", hb(), vec!["bash", "edit", "write"]);
    let general = shadow("general", hb(), vec![]);

    let read_turn = SelectCandidatesInput {
        shadows: vec![writer.clone(), general.clone()],
        active_shadow_ids: HashSet::new(),
        main_model_id: "openai/gpt".to_string(),
        executed_tools: Some(vec!["read".into()]),
    };
    let out = select_candidates(&read_turn);
    assert_eq!(out.tool_filtered, vec!["writer".to_string()]);
    assert_eq!(ids(&out.candidates), vec!["general".to_string()]);

    let edit_turn = SelectCandidatesInput {
        shadows: vec![writer, general],
        active_shadow_ids: HashSet::new(),
        main_model_id: "openai/gpt".to_string(),
        executed_tools: Some(vec!["edit".into()]),
    };
    let out = select_candidates(&edit_turn);
    assert!(out.tool_filtered.is_empty());
    let mut got = ids(&out.candidates);
    got.sort();
    assert_eq!(got, vec!["general".to_string(), "writer".to_string()]);
}

#[test]
fn decide_final_response_activates_only_final_trigger() {
    let input = DecideFinalResponseInput {
        shadows: vec![
            shadow("heartbeat", hb(), vec![]),
            shadow("final-a", fr(), vec!["write"]),
            shadow("final-b", vec![ShadowTrigger::Heartbeat, ShadowTrigger::FinalResponse], vec!["edit"]),
        ],
        main_model_id: "openai/gpt".to_string(),
        can_run_map: None,
    };
    let out = decide_final_response(&input);
    assert_eq!(
        out.activated.iter().map(|a| a.shadow.id.clone()).collect::<Vec<_>>(),
        vec!["final-a".to_string(), "final-b".to_string()],
    );
    assert!(out.candidates.iter().all(|c| c.selected));
}

#[test]
fn decide_final_response_applies_enabled_and_model_filters() {
    let mut disabled = shadow("disabled", fr(), vec![]);
    disabled.enabled = false;
    let other_model = with_models(shadow("other", fr(), vec![]), vec!["other/model"]);
    let input = DecideFinalResponseInput {
        shadows: vec![disabled, other_model],
        main_model_id: "openai/gpt".to_string(),
        can_run_map: None,
    };
    let out = decide_final_response(&input);
    assert!(out.activated.is_empty());
    assert_eq!(out.model_filtered, vec!["other".to_string()]);
}

#[test]
fn decide_final_response_round_limit() {
    let limited = shadow("limited", fr(), vec![]);
    let unlimited = shadow("unlimited", fr(), vec![]);
    let mut can_run = std::collections::HashMap::new();
    can_run.insert("limited".to_string(), false);
    can_run.insert("unlimited".to_string(), true);
    let input = DecideFinalResponseInput {
        shadows: vec![limited, unlimited],
        main_model_id: "openai/gpt".to_string(),
        can_run_map: Some(can_run),
    };
    let out = decide_final_response(&input);
    assert_eq!(
        out.activated.iter().map(|a| a.shadow.id.clone()).collect::<Vec<_>>(),
        vec!["unlimited".to_string()],
    );
    assert_eq!(out.round_filtered, vec!["limited".to_string()]);
}

// ---- matches_model: direct unit tests for pattern matching edge cases ----

#[test]
fn matches_model_empty_returns_false() {
    let s = with_models(shadow("s", hb(), vec![]), vec![]);
    assert!(!matches_model(&s, "openai/gpt"));
}

#[test]
fn matches_model_wildcard_matches_all() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["*"]);
    assert!(matches_model(&s, "anything/here"));
}

#[test]
fn matches_model_exact_and_provider_split() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["openai/gpt"]);
    assert!(matches_model(&s, "openai/gpt"));
    assert!(!matches_model(&s, "openai/other"));
    // Provider-less pattern matches the model part after '/'.
    let s = with_models(shadow("s", hb(), vec![]), vec!["gpt"]);
    assert!(matches_model(&s, "openai/gpt"));
}

#[test]
fn matches_model_wildcard_suffix() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["anthropic/*"]);
    assert!(matches_model(&s, "anthropic/claude"));
    assert!(!matches_model(&s, "openai/gpt"));
}

#[test]
fn matches_model_negative_excludes() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["*", "!openai/gpt"]);
    assert!(!matches_model(&s, "openai/gpt"));
    assert!(matches_model(&s, "anthropic/claude"));
}

#[test]
fn matches_model_negative_only() {
    let s = with_models(shadow("s", hb(), vec![]), vec!["!openai/gpt"]);
    assert!(!matches_model(&s, "openai/gpt"));
    assert!(matches_model(&s, "anthropic/claude"));
}

#[test]
fn matches_model_dot_is_literal_in_wildcard() {
    // In "a.*b" the '*' is wildcard but '.' is literal → matches "a.xb", not "axb".
    let s = with_models(shadow("s", hb(), vec![]), vec!["a.*b"]);
    assert!(matches_model(&s, "a.xb"));
    assert!(!matches_model(&s, "axb"));
}

// ---- should_evaluate_final_response: remaining edge cases ----

#[test]
fn final_response_empty_and_non_assistant() {
    assert!(!should_evaluate_final_response(&[]));
    let msgs = vec![json!({"role": "user", "content": "hi"})];
    assert!(!should_evaluate_final_response(&msgs));
}

#[test]
fn final_response_assistant_empty_string_is_false() {
    let msgs = vec![json!({"role": "assistant", "content": "   "})];
    assert!(!should_evaluate_final_response(&msgs));
}

#[test]
fn final_response_assistant_only_toolcall_is_false() {
    let msgs = vec![json!({"role": "assistant", "content": [{"type": "toolCall", "name": "read"}]})];
    assert!(!should_evaluate_final_response(&msgs));
}
