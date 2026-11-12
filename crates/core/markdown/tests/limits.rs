//! The bounds the parser declares, each held from both sides: the text just
//! inside is read, and the text just past it is refused.

use whiteboard_markdown::limits::{
    MAX_BYTES, MAX_CONTAINER_DEPTH, MAX_DEPTH, MAX_RUNS_PER_INLINE, fuel_for,
};
use whiteboard_markdown::{Refusal, parse, parse_counting};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn refusal(text: &str) -> Option<Refusal> {
    parse(text).err()
}

#[test]
fn a_text_over_the_byte_cap_is_refused_unread() {
    let text = "a".repeat(MAX_BYTES + 1);
    let (answer, spent) = parse_counting(&text);
    assert_eq!(answer.err(), Some(Refusal::TooLarge));
    assert_eq!(spent, 0, "a refusal for size reads nothing");
}

#[test]
fn a_text_of_exactly_the_byte_cap_is_read() {
    let text = "ab\n\n".repeat(MAX_BYTES / 4);
    assert_eq!(text.len(), MAX_BYTES);
    assert_eq!(refusal(&text), None);
}

#[test]
fn containers_opened_on_one_line_stop_at_the_container_cap() {
    for opener in ["- ", "> ", "1. ", "* ", "+ ", ">", "10) "] {
        let inside = format!("{}x", opener.repeat(MAX_CONTAINER_DEPTH));
        let past = format!("{}x", opener.repeat(MAX_CONTAINER_DEPTH + 1));
        assert_eq!(refusal(&inside), None, "{opener:?} x {MAX_CONTAINER_DEPTH}");
        assert_eq!(
            refusal(&past),
            Some(Refusal::TooDeep),
            "{opener:?} x {}",
            MAX_CONTAINER_DEPTH + 1
        );
    }
}

/// Indented four columns the markers are code, which opens no container, so
/// only what reads the line before the tokenizer does can count them.
#[test]
fn the_prescan_counts_markers_the_tokenizer_would_read_as_code() {
    for opener in ["- ", "> ", "1. ", "* ", "+ ", ">", "10) ", "7. "] {
        let line = |count: usize| format!("    {}x", opener.repeat(count));
        assert_eq!(refusal(&line(MAX_CONTAINER_DEPTH)), None, "{opener:?}");
        assert_eq!(refusal(&line(MAX_CONTAINER_DEPTH + 1)), Some(Refusal::TooDeep), "{opener:?}");
    }
}

/// A number counts only with its delimiter and a space after it.
#[test]
fn a_number_without_its_delimiter_and_a_space_is_not_a_marker() {
    for text in ["1.1.", "1)1)", "12", "1.x ", "1 ", "1.", ".", "1.."] {
        let line = format!("    {}x", text.repeat(MAX_CONTAINER_DEPTH + 1));
        assert_eq!(refusal(&line), None, "{text:?}");
    }
}

#[test]
fn quotes_and_items_count_together() {
    let line = format!("{}x", "> - ".repeat(MAX_CONTAINER_DEPTH / 2));
    assert_eq!(refusal(&line), None);
    let line = format!("{}x", "> - ".repeat(MAX_CONTAINER_DEPTH / 2 + 1));
    assert_eq!(refusal(&line), Some(Refusal::TooDeep));
}

/// Markers that open nothing are not containers: a break, a heading
/// underline, a number without its delimiter.
#[test]
fn markers_that_open_nothing_do_not_count() {
    let many = "-".repeat(500);
    assert_eq!(refusal(&many), None, "a run of dashes is a break");
    assert_eq!(refusal(&format!("{}x", "-x ".repeat(100))), None);
    assert_eq!(refusal(&format!("{}x", "12 ".repeat(100))), None);
    assert_eq!(refusal(&format!("{}x", "1.x ".repeat(100))), None);
}

/// Containers nested by indentation, a line each, are past what a line's
/// markers show: the events count them.
#[test]
fn lists_nested_by_indentation_stop_at_the_container_cap() {
    let nested = |depth: usize| {
        (0..depth).fold(String::new(), |text, level| format!("{text}{}- x\n", "  ".repeat(level)))
    };
    assert_eq!(refusal(&nested(MAX_CONTAINER_DEPTH)), None);
    assert_eq!(refusal(&nested(MAX_CONTAINER_DEPTH + 1)), Some(Refusal::TooDeep));
}

#[test]
fn nodes_nested_past_the_depth_cap_are_refused() {
    let image = |depth: usize| format!("{}x{}", "![".repeat(depth), "](u)".repeat(depth));
    assert_eq!(refusal(&image(8)), None);
    assert!(matches!(refusal(&image(MAX_DEPTH + 1)), Some(Refusal::TooDeep | Refusal::TooCostly)));
}

/// The run count and the fuel are separate bounds: padding the text gives it
/// the fuel the walks of a full run need, and only the count is left.
#[test]
fn an_inline_run_with_more_delimiter_runs_than_the_cap_is_refused() {
    let padding = "word\n\n".repeat(30_000);
    let run = |count: usize| format!("{padding}{}", "a* ".repeat(count));
    assert_eq!(refusal(&run(MAX_RUNS_PER_INLINE)), None);
    assert_eq!(refusal(&run(MAX_RUNS_PER_INLINE + 1)), Some(Refusal::TooCostly));
    let (_, spent) = parse_counting(&run(MAX_RUNS_PER_INLINE + 1));
    assert!(spent < fuel_for(run(0).len()) / 2, "refused by the count, not the fuel: {spent}");
}

/// The count is per inline run: many paragraphs of a few delimiters each are
/// as long as a text may be and cost nothing.
#[test]
fn the_run_cap_is_per_paragraph() {
    let text = "a* b* c*\n\n".repeat(MAX_RUNS_PER_INLINE);
    assert_eq!(refusal(&text), None);
}

#[test]
fn a_text_that_walks_the_same_ground_again_runs_out_of_fuel() {
    // A refused literal autolink is retried at the next position, over the
    // rest of the word.
    let text = "www._".repeat(8_000);
    let (answer, spent) = parse_counting(&text);
    assert_eq!(answer.err(), Some(Refusal::TooCostly));
    assert!(spent <= fuel_for(text.len()), "{spent} units");
    assert!(spent > fuel_for(text.len()) / 2, "refused after {spent} of {}", fuel_for(text.len()));
}

#[test]
fn the_fuel_grows_with_the_text_and_never_wraps() {
    assert!(fuel_for(0) > 0, "a short text is not refused for being short");
    assert!(fuel_for(1_000) < fuel_for(2_000));
    assert!(fuel_for(usize::MAX) >= fuel_for(MAX_BYTES));
}
