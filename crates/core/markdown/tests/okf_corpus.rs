//! The parser reads the bodies of this repository's own recorded OKF documents.
//!
//! `packages/codec/src/okf/oracle/okf.jsonl` holds what `parseOkf` answered for
//! documents the codec's tests feed it; a reader case that parsed carries the
//! document's body, which is what the layout would hand to this parser. It is
//! a smoke corpus, not a tree oracle: that is a later slice, and compares
//! these trees with the TypeScript's.

use serde_json::Value as Json;
use whiteboard_markdown::limits::fuel_for;
use whiteboard_markdown::mdast::Node;
use whiteboard_markdown::parse_counting;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// The text after the front matter of every recorded reader case, or the
/// whole text of one that has none. Rough on purpose: a case whose fences are
/// broken is exactly the kind of text the parser must read anyway.
fn bodies() -> Vec<String> {
    let text = include_str!("../../../../packages/codec/src/okf/oracle/okf.jsonl");
    let mut found = std::collections::BTreeSet::new();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Json>(line) else { continue };
        let Some(document) = record.get("t").and_then(Json::as_str) else { continue };
        let body = document
            .strip_prefix("---\n")
            .or_else(|| document.strip_prefix("---\r\n"))
            .and_then(|rest| rest.split_once("\n---"))
            .map_or(document, |(_, after)| after.trim_start_matches(['\r', '\n']));
        found.insert(body.to_string());
    }
    found.into_iter().collect()
}

fn kinds(node: &Node, seen: &mut std::collections::BTreeSet<&'static str>) {
    seen.insert(match node {
        Node::Heading(_) => "heading",
        Node::List(_) => "list",
        Node::Code(_) => "code",
        Node::Link(_) => "link",
        Node::Table(_) => "table",
        Node::Blockquote(_) => "blockquote",
        Node::Emphasis(_) => "emphasis",
        Node::InlineCode(_) => "inline code",
        _ => "other",
    });
    for child in node.children().into_iter().flatten() {
        kinds(child, seen);
    }
}

#[test]
fn every_recorded_body_is_read_into_a_tree() {
    let bodies = bodies();
    // The recording holds several hundred distinct bodies; a count far under
    // that means the reader above missed the field, not that the corpus shrank.
    assert!(bodies.len() > 400, "{} bodies", bodies.len());

    let mut seen = std::collections::BTreeSet::new();
    let mut costliest = 0_usize;
    for body in &bodies {
        let (answer, spent) = parse_counting(body);
        let Ok(root) = answer else {
            panic!("{body:?} was refused: {answer:?}");
        };
        assert!(matches!(root, Node::Root(_)), "{body:?}");
        kinds(&root, &mut seen);
        if body.len() > 200 {
            costliest = costliest.max(spent.saturating_mul(1000) / body.len());
        }
    }
    // The bodies are not all prose: the corpus reaches the constructs a layout
    // draws.
    for kind in ["heading", "list", "code", "link", "blockquote", "emphasis", "inline code"] {
        assert!(seen.contains(kind), "no {kind} in the corpus: {seen:?}");
    }
    // The fuel a text may spend is at least three times what the dearest of
    // these took per byte, so none of them comes near being refused.
    let granted = fuel_for(1 << 20) / (1 << 20);
    assert!(
        costliest * 3 < granted * 1000,
        "{costliest} units a kilobyte against {granted} a byte"
    );
}
