//! The parser answers every text with a tree or a refusal, never a panic,
//! and never goes past the bounds it declares.
//!
//! A panic in a wasm instance poisons it, so this is the property the
//! `markdown_parse` fuzz target also holds, there over the bytes a fuzzer
//! chooses and here over documents of the tokens that decide how markdown parses.

use whiteboard_markdown::limits::{MAX_BYTES, MAX_CONTAINER_DEPTH, MAX_DEPTH, fuel_for};
use whiteboard_markdown::mdast::Node;
use whiteboard_markdown::{Refusal, parse_counting};
use whiteboard_proptest::proptest::prelude::{Strategy, any, prop, prop_assert, prop_oneof};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// Delimiters, containers, entities, HTML, CJK, math, references, line
/// endings and the control characters a tokenizer has to place.
const TOKENS: &[&str] = &[
    "*",
    "**",
    "***",
    "_",
    "__",
    "~",
    "~~",
    "`",
    "``",
    "$",
    "$$",
    "[",
    "]",
    "(",
    ")",
    "![",
    "](",
    "<",
    ">",
    "&amp;",
    "&#x41;",
    "&#0;",
    "&bogus;",
    "&nbsp;",
    "\\",
    "\\*",
    "\n",
    "\n\n",
    "    ",
    "\t",
    "- ",
    "* ",
    "+ ",
    "1. ",
    "2) ",
    "> ",
    "# ",
    "## ",
    "|",
    " | ",
    "|---|",
    "---",
    "===",
    " ",
    "  \n",
    "a",
    "foo",
    "b c",
    "日本語",
    "漢字",
    "。",
    "「",
    "」",
    "、",
    "한국어",
    "😀",
    "[[Page]]",
    "![[img.png]]",
    "[[a|b]]",
    "[[Doc#h]]",
    ":smile:",
    ":+1:",
    "<div>",
    "</div>",
    "<!-- c -->",
    "<span>",
    "</span>",
    "<br>",
    "http://x.y/z",
    "https://a.b",
    "www.example.com",
    "a@b.co",
    "[^1]",
    "[^1]: note",
    "- [ ] ",
    "- [x] ",
    "[x]: /u \"t\"",
    "$$\n",
    "\n$$",
    "```\n",
    "\n```",
    "~~~js\n",
    "\\(",
    "\\[",
    "\\$",
    "\u{a0}",
    "\u{200b}",
    "\r\n",
    "\r",
    "\0",
    "---\n",
    "-\n",
    "--\n",
    "1.",
    "+\n",
    "1)\n",
    "# #",
    "<a",
    "<http://",
    "www.",
    "@",
    ":",
];

/// A document of 1 to `max` tokens.
fn token_document(max: usize) -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(TOKENS), 1..=max).prop_map(|parts| parts.concat())
}

/// Token documents most of the time, and arbitrary text for the rest.
fn any_document() -> impl Strategy<Value = String> {
    prop_oneof![
        8 => token_document(40),
        1 => any::<String>(),
        1 => prop::collection::vec(prop::sample::select(TOKENS), 40..=200)
            .prop_map(|parts| parts.concat()),
    ]
}

/// The deepest nesting of nodes in a tree, and of block containers.
fn depths(node: &Node, containers: usize) -> (usize, usize) {
    let own = usize::from(matches!(
        node,
        Node::Blockquote(_) | Node::ListItem(_) | Node::FootnoteDefinition(_)
    ));
    let containers = containers + own;
    let mut deepest = (1, containers);
    for child in node.children().into_iter().flatten() {
        let (below, below_containers) = depths(child, containers);
        deepest = (deepest.0.max(below + 1), deepest.1.max(below_containers));
    }
    deepest
}

#[test]
fn any_text_is_answered_within_its_bounds() {
    let parsed = Floor::new("parsed into a tree with something in it");
    let refused = Floor::new("refused");
    check(any_document(), None, |text| {
        let (answer, spent) = parse_counting(&text);
        prop_assert!(spent <= fuel_for(text.len()), "spent {spent} on {} bytes", text.len());
        match answer {
            Ok(root) => {
                let (nodes, containers) = depths(&root, 0);
                prop_assert!(nodes <= MAX_DEPTH + 1 && containers <= MAX_CONTAINER_DEPTH);
                parsed.draw(root.children().is_some_and(|children| !children.is_empty()));
                refused.draw(false);
            }
            Err(Refusal::TooLarge) => prop_assert!(text.len() > MAX_BYTES),
            Err(_) => refused.draw(true),
        }
        Ok(())
    });
    // Most draws are read, and the ones that nest or run long are refused, so
    // neither arm is vacuous.
    parsed.assert(100);
}
