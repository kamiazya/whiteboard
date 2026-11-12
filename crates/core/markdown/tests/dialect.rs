//! The syntax the parser reads: `CommonMark`, GFM and math, as the
//! TypeScript parser reads them, and nothing more.

mod common;

use common::shape;
use whiteboard_markdown::parse;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn read(text: &str) -> String {
    parse(text).map_or_else(|refusal| format!("refused: {refusal:?}"), |root| shape(&root))
}

#[test]
fn commonmark_blocks_and_inlines() {
    assert_eq!(
        read("# Hi *Earth*!\n\n> q\n\n- a\n- b\n\n1. c\n\n```js\nx\n```\n\n---\n"),
        r#"root(h[1](text["Hi "] em(text["Earth"]) text["!"]) quote(p(text["q"])) ul(li(p(text["a"])) li(p(text["b"]))) ol(li(p(text["c"]))) code["x"] hr)"#
    );
}

#[test]
fn gfm_tables_strikethrough_task_items_and_autolinks() {
    assert_eq!(
        read("|a|b|\n|-|-|\n|1|2|\n"),
        r#"root(table(row(cell(text["a"]) cell(text["b"])) row(cell(text["1"]) cell(text["2"]))))"#
    );
    // One tilde strikes through, as remark-gfm reads it by default.
    assert_eq!(read("~a~ ~~b~~"), r#"root(p(del(text["a"]) text[" "] del(text["b"])))"#);
    assert_eq!(read("- [x] done"), r#"root(ul(li(p(text["done"]))))"#);
    assert_eq!(
        read("www.example.com"),
        r#"root(p(link[http://www.example.com](text["www.example.com"])))"#
    );
}

#[test]
fn math_reads_with_a_single_dollar() {
    let tree = parse("$a$ and $$\nb\n$$\n");
    let Ok(whiteboard_markdown::mdast::Node::Root(root)) = tree else { panic!("{tree:?}") };
    let kinds: Vec<&str> = root
        .children
        .iter()
        .map(|node| match node {
            whiteboard_markdown::mdast::Node::Paragraph(_) => "paragraph",
            whiteboard_markdown::mdast::Node::Math(_) => "math",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, ["paragraph", "math"]);
    assert!(format!("{root:?}").contains("InlineMath"), "{root:?}");
}

/// Wiki-links and embeds are a pass over text nodes, not syntax of the parser.
#[test]
fn a_reference_is_text() {
    assert_eq!(read("[[Page]] and ![[img.png]]"), r#"root(p(text["[[Page]] and ![[img.png]]"]))"#);
}

/// Front matter and MDX are not part of the dialect: the fence is a break and
/// a heading, braces and tags are text and HTML.
#[test]
fn front_matter_and_mdx_are_not_syntax() {
    assert_eq!(read("---\ntitle: x\n---\n"), r#"root(hr h[2](text["title: x"]))"#);
    assert_eq!(read("{1 + 1}"), r#"root(p(text["{1 + 1}"]))"#);
    assert_eq!(read("import x from 'y'"), r#"root(p(text["import x from 'y'"]))"#);
}
