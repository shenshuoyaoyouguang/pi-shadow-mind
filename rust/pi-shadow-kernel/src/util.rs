//! Shared helpers that mirror JavaScript string semantics exactly.
//!
//! JS string `.length` counts UTF-16 code units and `Array.from(s)` yields code
//! points; several ported modules depend on both (notably `fitTrajectory`, whose
//! tests assert astral-character budgets). Rust `str::len()` is UTF-8 bytes, so we
//! cannot use it where the TS used `.length`.

use regex::Regex;
use std::sync::OnceLock;

static WS_RE: OnceLock<Regex> = OnceLock::new();
fn ws_re() -> &'static Regex {
    WS_RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}

/// Equivalent to JS `text.replace(/\s+/g, " ").trim()`.
pub fn flatten_ws(text: &str) -> String {
    ws_re().replace_all(text, " ").trim().to_string()
}

/// JS string `.length` — the number of UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.chars()
        .map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 })
        .sum()
}

/// JS `Array.from(s).slice(0, n).join("")` — the first `n` code points.
pub fn codepoints_take(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// JS `str.slice(0, n)` measured in UTF-16 units.
pub fn utf16_slice_start(s: &str, n: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for c in s.chars() {
        let cu = if (c as u32) > 0xFFFF { 2 } else { 1 };
        if units + cu > n {
            break;
        }
        out.push(c);
        units += cu;
    }
    out
}

/// Number of Unicode code points (`Array.from(s).length`).
pub fn codepoint_count(s: &str) -> usize {
    s.chars().count()
}
