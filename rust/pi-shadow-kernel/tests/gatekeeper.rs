//! Behavior-equivalence tests mirroring `test/gatekeeper.test.ts` (pure halves).

use pi_shadow_kernel::gatekeeper::{
    build_gatekeeper_prompt, fit_trajectory, parse_gatekeeper_reply, GatekeeperActivation,
};
use pi_shadow_kernel::types::{ShadowDefinition, ShadowTrigger};
use std::collections::HashSet;

fn candidate(id: &str, prompt: &str) -> ShadowDefinition {
    ShadowDefinition {
        id: id.to_string(),
        name: id.to_string(),
        enabled: true,
        debug: false,
        trigger: vec![ShadowTrigger::Heartbeat],
        active_for_models: vec!["*".to_string()],
        run_with_model: None,
        thinking_level: None,
        timeout_seconds: None,
        final_response_rounds: None,
        activation_tools: vec![],
        tools: vec![],
        prompt: prompt.to_string(),
        file_path: format!("{}.md", id),
        extra_fields: None,
    }
}

fn ids(items: &[&str]) -> HashSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn activations(reply: &str, candidate_ids: &[&str]) -> Vec<GatekeeperActivation> {
    parse_gatekeeper_reply(reply, &ids(candidate_ids)).expect("reply should parse")
}

#[test]
fn parses_plain_json_object() {
    let out = activations(r#"{"activations":[{"id":"a","brief":"x"}]}"#, &["a", "b"]);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "a");
    assert_eq!(out[0].brief, "x");
}

#[test]
fn parses_json_inside_markdown_fence() {
    let out = activations("```json\n{\"activations\":[{\"id\":\"b\"}]}\n```", &["a", "b"]);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "b");
    assert_eq!(out[0].brief, "");
}

#[test]
fn extracts_first_json_from_surrounding_prose() {
    let out = activations(
        r#"Sure! {"activations":[{"id":"a","brief":"y"},{"id":"a","brief":"dup"},{"id":"ghost"}]}"#,
        &["a", "b"],
    );
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "a");
    assert_eq!(out[0].brief, "y");
}

#[test]
fn ignores_trailing_prose_with_further_braces() {
    let out = activations(
        r#"{"activations":[{"id":"a","brief":"z"}]} Done {note: no more objects}"#,
        &["a", "b"],
    );
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "a");
    assert_eq!(out[0].brief, "z");
}

#[test]
fn throws_on_non_json_or_non_array_activations() {
    assert!(parse_gatekeeper_reply("no json", &ids(&["a"])).is_err());
    assert!(parse_gatekeeper_reply(r#"{"activations":"nope"}"#, &ids(&["a"])).is_err());
}

#[test]
fn fit_returns_input_unchanged_when_it_fits() {
    let (text, truncated) = fit_trajectory("USER: hi\nMAIN: ok", 1000, 0);
    assert!(!truncated);
    assert_eq!(text, "USER: hi\nMAIN: ok");
}

#[test]
fn fit_keeps_first_user_segment_plus_tail_and_flags_truncation() {
    let trajectory = [
        "USER: original task",
        "MAIN: a",
        "MAIN: b",
        "TOOL: read(x)",
        "TOOL: write(y)",
    ]
    .join("\n");
    let (text, truncated) = fit_trajectory(&trajectory, 40, 0);
    assert!(truncated);
    assert!(text.contains("USER: original task"));
    assert!(text.contains("TOOL: write(y)"));
    assert!(!text.contains("MAIN: a\n"));
    assert!(text.len() <= 40 + 64);
}

#[test]
fn fit_preserves_initial_user_segment_case_insensitively() {
    let trajectory = ["User: original task", "Main: middle content", "TOOL: final"].join("\n");
    let (text, truncated) = fit_trajectory(&trajectory, 35, 0);
    assert!(truncated);
    assert!(text.contains("User: original task"));
    assert!(text.contains("TOOL: final"));
    assert!(!text.contains("Main: middle content"));
}

#[test]
fn fit_keeps_wrapper_and_first_user_segment() {
    let trajectory = [
        "<main-agent-trajectory>",
        "USER: original task",
        "MAIN: a",
        "MAIN: b",
        "TOOL: read(x)",
        "TOOL: write(y)",
    ]
    .join("\n");
    let (text, truncated) = fit_trajectory(&trajectory, 60, 0);
    assert!(truncated);
    assert!(text.contains("<main-agent-trajectory>"));
    assert!(text.contains("USER: original task"));
    assert!(text.contains("TOOL: write(y)"));
}

#[test]
fn build_prompt_formats_candidate_list() {
    let prompt = build_gatekeeper_prompt(&[candidate("a", "check facts")], "TRAJ");
    assert!(prompt.candidate_summaries.starts_with("- a | a | check facts"));
    assert!(prompt.user_message.contains("Candidates:\n- a | a | check facts"));
    assert!(prompt.user_message.contains("Trajectory:\nTRAJ"));
    assert!(!prompt.system_prompt.is_empty());
}

#[test]
fn build_prompt_uses_none_when_no_candidates() {
    let prompt = build_gatekeeper_prompt(&[], "TRAJ");
    assert_eq!(prompt.candidate_summaries, "(none)");
}
