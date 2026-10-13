//! Direct tests for `util.rs` — the JS string-semantics helpers.
//!
//! These underpin UTF-16/code-point parity with TypeScript: `fitTrajectory` and
//! brief capping depend on JS `.length` (UTF-16 units) and `Array.from(s)`
//! (code points), so the helpers must match exactly across ASCII, BMP, and astral
//! (surrogate-pair) characters. `flatten_ws` must treat Unicode whitespace the same
//! as JS `/\s+/g` (which is Unicode-aware).

use pi_shadow_kernel::util::{
    codepoint_count, codepoints_take, flatten_ws, utf16_len, utf16_slice_start,
};

#[test]
fn flatten_ws_collapses_runs_and_trims() {
    assert_eq!(flatten_ws("a\n\n   b\tc"), "a b c");
}

#[test]
fn flatten_ws_empty_and_whitespace_only() {
    assert_eq!(flatten_ws(""), "");
    assert_eq!(flatten_ws("   \n\t  "), "");
}

#[test]
fn flatten_ws_preserves_single_spaces() {
    assert_eq!(flatten_ws("a b c"), "a b c");
}

#[test]
fn flatten_ws_handles_unicode_whitespace() {
    // U+3000 ideographic space and U+00A0 NBSP are Unicode whitespace in both
    // Rust (regex Unicode mode) and JS.
    assert_eq!(flatten_ws("a\u{3000}b"), "a b");
    assert_eq!(flatten_ws("a\u{00A0}b"), "a b");
}

#[test]
fn utf16_len_ascii() {
    assert_eq!(utf16_len("hello"), 5);
}

#[test]
fn utf16_len_bmp_non_ascii() {
    // U+4E2D (中) is in the BMP → 1 UTF-16 unit.
    assert_eq!(utf16_len("中"), 1);
    assert_eq!(utf16_len("a中b"), 3);
}

#[test]
fn utf16_len_astral_is_two_units() {
    // U+1F600 (😀) is astral → 2 UTF-16 units (surrogate pair).
    assert_eq!(utf16_len("😀"), 2);
    assert_eq!(utf16_len("a😀b"), 4);
}

#[test]
fn codepoints_take_basic() {
    assert_eq!(codepoints_take("hello", 3), "hel");
}

#[test]
fn codepoints_take_exceeds_length() {
    assert_eq!(codepoints_take("ab", 10), "ab");
}

#[test]
fn codepoints_take_zero() {
    assert_eq!(codepoints_take("abc", 0), "");
}

#[test]
fn codepoints_take_astral_counts_as_one() {
    // Code points, not UTF-16 units: one emoji = one code point.
    assert_eq!(codepoints_take("😀😀😀", 2), "😀😀");
}

#[test]
fn utf16_slice_start_ascii() {
    assert_eq!(utf16_slice_start("hello", 3), "hel");
}

#[test]
fn utf16_slice_start_stops_before_splitting_surrogate() {
    // "a😀" is 1 + 2 = 3 UTF-16 units. Slicing to 2 keeps "a" (cannot split the pair).
    assert_eq!(utf16_slice_start("a😀", 2), "a");
    assert_eq!(utf16_slice_start("a😀", 3), "a😀");
}

#[test]
fn utf16_slice_start_zero() {
    assert_eq!(utf16_slice_start("abc", 0), "");
}

#[test]
fn codepoint_count_basic() {
    assert_eq!(codepoint_count("hello"), 5);
}

#[test]
fn codepoint_count_astral() {
    assert_eq!(codepoint_count("😀😀"), 2);
}
