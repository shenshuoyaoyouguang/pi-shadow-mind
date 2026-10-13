//! Behavior-equivalence tests mirroring `test/usage.test.ts`.

use pi_shadow_kernel::types::{ShadowUsage, ShadowUsageCost};
use pi_shadow_kernel::usage::{
    add_usage, format_usage_cost, format_usage_detail, format_usage_summary, format_usage_tokens,
    zero_usage,
};

fn usage(
    requests: u64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total_tokens: u64,
    cost_total: f64,
) -> ShadowUsage {
    ShadowUsage {
        requests,
        input,
        output,
        cache_read,
        cache_write,
        total_tokens,
        cost: ShadowUsageCost {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total: cost_total,
        },
    }
}

#[test]
fn zero_and_add() {
    let left = usage(1, 10, 20, 30, 40, 100, 0.1);
    let right = usage(2, 1, 2, 3, 4, 10, 0.01);
    assert_eq!(zero_usage(), usage(0, 0, 0, 0, 0, 0, 0.0));
    let added = add_usage(&left, &right);
    assert_eq!(added.requests, 3);
    assert_eq!(added.input, 11);
    assert_eq!(added.output, 22);
    assert_eq!(added.cache_read, 33);
    assert_eq!(added.cache_write, 44);
    assert_eq!(added.total_tokens, 110);
    assert!((added.cost.total - 0.11).abs() < 1e-9);
}

#[test]
fn format_tokens_boundaries() {
    assert_eq!(format_usage_tokens(999), "999");
    assert_eq!(format_usage_tokens(1_000), "1k");
    assert_eq!(format_usage_tokens(84_700), "84.7k");
    assert_eq!(format_usage_tokens(999_950), "1m");
    assert_eq!(format_usage_tokens(1_250_000), "1.3m");
}

#[test]
fn format_cost_boundaries() {
    assert_eq!(format_usage_cost(0.0), "$0");
    assert_eq!(format_usage_cost(0.0042), "$0.004");
    assert_eq!(format_usage_cost(0.42), "$0.42");
}

#[test]
fn format_summary_and_detail() {
    let sample = usage(2, 70_000, 10_000, 4_000, 700, 84_700, 0.42);
    assert_eq!(
        format_usage_summary(&sample),
        "2 requests · 84.7k tokens · API $0.42",
    );
    assert_eq!(
        format_usage_detail("session", &sample),
        "usage session · 2 requests · 84.7k total · 70k input · 10k output · 4k cache read · 700 cache write · API $0.42",
    );
}

#[test]
fn format_cost_tier_boundaries() {
    assert_eq!(format_usage_cost(0.01), "$0.01");
    assert_eq!(format_usage_cost(0.001), "$0.001");
    assert_eq!(format_usage_cost(0.0001), "$0.0001");
    assert_eq!(format_usage_cost(0.009), "$0.009");
    assert_eq!(format_usage_cost(0.0009), "$0.0009");
    assert_eq!(format_usage_cost(0.00001), "$0.0000");
}

#[test]
fn format_tokens_m_boundary() {
    assert_eq!(format_usage_tokens(999_949), "999.9k");
    assert_eq!(format_usage_tokens(999_950), "1m");
    assert_eq!(format_usage_tokens(1_000_000), "1m");
}

#[test]
fn format_tokens_extreme_no_panic() {
    let out = format_usage_tokens(u64::MAX);
    assert!(out.ends_with('m'));
}

#[test]
fn add_usage_saturates_on_overflow() {
    let mut m = zero_usage();
    m.requests = u64::MAX;
    m.input = u64::MAX;
    let added = add_usage(&m, &m);
    assert_eq!(added.requests, u64::MAX);
    assert_eq!(added.input, u64::MAX);
}
