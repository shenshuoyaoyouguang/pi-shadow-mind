//! Usage accounting and formatting, mirroring `src/usage.ts`.

use crate::types::{ShadowUsage, ShadowUsageCost};

pub fn zero_usage() -> ShadowUsage {
    ShadowUsage::default()
}

pub fn add_usage(left: &ShadowUsage, right: &ShadowUsage) -> ShadowUsage {
    ShadowUsage {
        requests: left.requests.saturating_add(right.requests),
        input: left.input.saturating_add(right.input),
        output: left.output.saturating_add(right.output),
        cache_read: left.cache_read.saturating_add(right.cache_read),
        cache_write: left.cache_write.saturating_add(right.cache_write),
        total_tokens: left.total_tokens.saturating_add(right.total_tokens),
        cost: ShadowUsageCost {
            input: left.cost.input + right.cost.input,
            output: left.cost.output + right.cost.output,
            cache_read: left.cost.cache_read + right.cost.cache_read,
            cache_write: left.cost.cache_write + right.cost.cache_write,
            total: left.cost.total + right.cost.total,
        },
    }
}

/// `Number(value.toFixed(1)).toString()` — one decimal, trailing `.0` stripped.
fn format_compact(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    let s = format!("{:.1}", rounded);
    if s.ends_with(".0") {
        s[..s.len() - 2].to_string()
    } else {
        s
    }
}

pub fn format_usage_tokens(tokens: u64) -> String {
    if tokens < 1_000 {
        return tokens.to_string();
    }
    if tokens < 999_950 {
        return format!("{}k", format_compact(tokens as f64 / 1_000.0));
    }
    format!("{}m", format_compact(tokens as f64 / 1_000_000.0))
}

pub fn format_usage_cost(cost: f64) -> String {
    if cost == 0.0 {
        return "$0".to_string();
    }
    if cost >= 0.01 {
        return format!("${:.2}", cost);
    }
    if cost >= 0.001 {
        return format!("${:.3}", cost);
    }
    format!("${:.4}", cost)
}

pub fn format_usage_summary(usage: &ShadowUsage) -> String {
    format!(
        "{} requests · {} tokens · API {}",
        usage.requests,
        format_usage_tokens(usage.total_tokens),
        format_usage_cost(usage.cost.total)
    )
}

pub fn format_usage_detail(scope: &str, usage: &ShadowUsage) -> String {
    [
        format!("usage {}", scope),
        format!("{} requests", usage.requests),
        format!("{} total", format_usage_tokens(usage.total_tokens)),
        format!("{} input", format_usage_tokens(usage.input)),
        format!("{} output", format_usage_tokens(usage.output)),
        format!("{} cache read", format_usage_tokens(usage.cache_read)),
        format!("{} cache write", format_usage_tokens(usage.cache_write)),
        format!("API {}", format_usage_cost(usage.cost.total)),
    ]
    .join(" · ")
}
