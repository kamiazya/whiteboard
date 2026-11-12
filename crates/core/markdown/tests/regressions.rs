//! The two inputs that panicked the upstream parser, and the neighbours of
//! each that shape the fix.
//!
//! Both are in this repository's own recorded OKF oracle or one step from it,
//! and a panic in a wasm instance poisons it.

mod common;

use common::shape;
use whiteboard_markdown::parse;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn read(text: &str) -> String {
    match parse(text) {
        Ok(root) => shape(&root),
        Err(refusal) => format!("refused: {refusal:?}"),
    }
}

/// A setext heading, then a thematic break, then a second setext heading
/// panicked with `Cannot push to non-parent`: the first underline read as the
/// start of a paragraph, and the second heading was wrapped around events the
/// first one had already moved.
#[test]
fn a_heading_a_break_and_a_heading_read_as_three_blocks() {
    assert_eq!(read("a\n---\n---\nb\n---\n"), r#"root(h[2](text["a"]) hr h[2](text["b"]))"#);
}

#[test]
fn an_underline_after_an_underline_that_made_a_heading_is_a_break_or_text() {
    assert_eq!(read("x\n---\n---\n"), r#"root(h[2](text["x"]) hr)"#);
    assert_eq!(read("x\n===\n===\n"), r#"root(h[1](text["x"]) p(text["==="]))"#);
    assert_eq!(read("x\n---\n--\ny\n"), r#"root(h[2](text["x"]) p(text["--\ny"]))"#);
}

#[test]
fn an_underline_of_two_dashes_is_not_a_break() {
    assert_eq!(read("x\n-\n--\nr\n-"), r#"root(h[2](text["x"]) h[2](text["--\nr"]))"#);
}

#[test]
fn an_underline_after_a_definition_with_a_paragraph_below_is_a_break() {
    assert_eq!(read("[a]: /u\n---\nc\n"), r#"root(def[/u] hr p(text["c"]))"#);
}

/// The OKF oracle's bodies, whose front matter (`--` on its own line, then
/// fields, then a fence of three) makes the same arrangement.
#[test]
fn the_recorded_bodies_that_panicked_read_as_a_heading_a_break_and_a_heading() {
    let first = "--\ntype: café\ntitle: a}b\nview: =\ndescription: \"1e3\"\n---\n---\nnot frontmatter\n---\n";
    let second = "--\r\ngenerated:\r\n  by: process:nightly\r\ntype: ?x\r\ndescription: :x\r\n---\r\n---\r\nnot frontmatter\r\n---\r\n";
    for body in [first, second] {
        let read = read(body);
        assert!(read.starts_with("root(h[2](text[\"--"), "{read}");
        assert!(read.ends_with(r#" hr h[2](text["not frontmatter"]))"#), "{read}");
    }
}

/// A fenced code in a list item that never closes, then a list of the other
/// kind: the first item's end was found by skipping past every list item that
/// followed, so both lists ended after the second and crossed.
#[test]
fn an_item_ending_in_an_open_fence_ends_before_the_next_list() {
    assert_eq!(read("- ```\n1."), r#"root(ul(li(code[""])) ol(li))"#);
    assert_eq!(read("- ```\n+"), r#"root(ul(li(code[""])) ul(li))"#);
    assert_eq!(read("- ```\n2) x"), r#"root(ul(li(code[""])) ol(li(p(text["x"]))))"#);
}

#[test]
fn the_recorded_body_that_crossed_two_lists_reads_as_two() {
    let body = "」  \n\r\n- ```\n1.  | ~***www.example.com2) |---|]([[Doc#h]]**![[img.png]]\\](\\。|---|:+1:&#0;*。www.example.com![[img.png]]</div>---";
    let read = read(body);
    assert!(read.starts_with(r#"root(p(text["」"]) ul(li(code[""])) ol(li(p("#), "{read}");
}
