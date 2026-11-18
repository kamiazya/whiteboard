//! `markdown_excerpt`: a body as one line of plain text, the rail row's summary.

use whiteboard_codec::markdown::markdown_excerpt;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[test]
fn says_what_the_body_says_without_the_syntax_that_draws_it() {
    assert_eq!(markdown_excerpt("**tighten** the copy here"), "tighten the copy here");
    assert_eq!(markdown_excerpt("a `code` span and a [link](http://x)"), "a code span and a link");
}

#[test]
fn does_not_invent_a_space_markdown_never_had_inside_a_word() {
    assert_eq!(markdown_excerpt("a**b**c"), "abc");
}

#[test]
fn turns_a_block_boundary_into_a_space() {
    assert_eq!(markdown_excerpt("# Ship it\n\nafter review"), "Ship it after review");
    assert_eq!(markdown_excerpt("- one\n- two"), "one two");
    assert_eq!(markdown_excerpt("> quoted\n\nnext"), "quoted next");
    assert_eq!(markdown_excerpt("a\n\n---\n\nb"), "a b");
}

#[test]
fn nested_lists_read_in_order() {
    assert_eq!(markdown_excerpt("- a\n  - b\n  - c\n- d"), "a b c d");
    assert_eq!(markdown_excerpt("1. a\n2. b"), "a b");
}

#[test]
fn carries_an_images_alt_and_nothing_for_an_empty_one() {
    assert_eq!(
        markdown_excerpt("before ![the failing chart](x.png) after"),
        "before the failing chart after"
    );
    assert_eq!(markdown_excerpt("a![](x.png)b"), "ab");
}

#[test]
fn a_code_fence_contributes_its_source() {
    assert_eq!(markdown_excerpt("```rust\nfn  x() {}\n```\n\nafter"), "fn x() {} after");
}

#[test]
fn table_cells_are_not_blocks_and_rows_are() {
    assert_eq!(markdown_excerpt("| a | b |\n|---|---|\n| c | d |\n\nz"), "ab cd z");
}

#[test]
fn a_hard_break_adds_nothing_and_a_soft_one_is_a_space() {
    assert_eq!(markdown_excerpt("a  \nb"), "ab");
    assert_eq!(markdown_excerpt("a\nb"), "a b");
}

#[test]
fn html_and_math_values_are_carried() {
    assert_eq!(markdown_excerpt("<b>x</b> $y$"), "<b>x</b> y");
    assert_eq!(markdown_excerpt("$$\nz\n$$"), "z");
}

#[test]
fn collapses_javascript_whitespace_only() {
    assert_eq!(markdown_excerpt("a\u{a0}\u{3000} b"), "a b");
    assert_eq!(markdown_excerpt("a\u{85}b"), "a\u{85}b");
    assert_eq!(markdown_excerpt("\u{feff}a\u{feff}"), "a");
}

#[test]
fn cjk_text_is_kept_whole() {
    assert_eq!(markdown_excerpt("# 見出し\n\n**太字**です"), "見出し 太字です");
}

#[test]
fn nothing_in_a_body_is_the_empty_string() {
    assert_eq!(markdown_excerpt(""), "");
    assert_eq!(markdown_excerpt("\n\n"), "");
}

#[test]
fn a_body_past_the_parsers_bounds_is_its_trimmed_source() {
    let deep = format!("  {}x  ", ">".repeat(100_000));
    assert_eq!(markdown_excerpt(&deep), deep.trim());
}
