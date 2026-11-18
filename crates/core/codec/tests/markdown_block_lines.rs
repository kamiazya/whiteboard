//! `parse_markdown_block_lines`: the 1-based start line of each top-level block
//! of a body, index-aligned with `parse_markdown_body`'s root children.

use whiteboard_codec::markdown::{parse_markdown_block_lines, parse_markdown_body};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn lines(text: &str) -> Vec<usize> {
    parse_markdown_block_lines(text)
}

#[test]
fn an_empty_body_has_no_blocks() {
    assert_eq!(lines(""), Vec::<usize>::new());
    assert_eq!(lines("\n\n  \n"), Vec::<usize>::new());
}

#[test]
fn each_top_level_block_reports_the_line_it_starts_on() {
    assert_eq!(lines("# Title\n\nfirst\nsecond\n\nthird"), vec![1, 3, 6]);
}

#[test]
fn leading_blank_lines_are_counted() {
    assert_eq!(lines("\n\n# Title\n\ntext"), vec![3, 5]);
}

#[test]
fn a_crlf_body_counts_the_same_lines_as_an_lf_one() {
    assert_eq!(lines("# Title\r\n\r\nfirst\r\nsecond\r\n\r\nthird"), vec![1, 3, 6]);
}

#[test]
fn a_block_that_spans_lines_reports_its_first() {
    let body = "- a\n- b\n\n```rust\nfn x() {}\n\n\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n> more";
    assert_eq!(lines(body), vec![1, 4, 10, 14]);
}

#[test]
fn the_lines_are_as_many_as_the_model_tree_has_top_level_blocks() {
    for body in ["", "a", "a\n\nb\n\n---\n\n$$\nx\n$$", "[[x]]\n\n![[y]]\n\n<div>\n\nhtml\n</div>"]
    {
        let blocks = parse_markdown_body(body).map(|root| root.children.len());
        assert_eq!(Ok(lines(body).len()), blocks.map_err(|_| ()), "{body:?}");
    }
}

#[test]
fn a_body_past_the_parsers_bounds_is_one_block_at_line_one() {
    let deep = "> ".repeat(2_000) + "x";
    assert!(parse_markdown_body(&deep).is_err());
    assert_eq!(lines(&deep), vec![1]);
}
