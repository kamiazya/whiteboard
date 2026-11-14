//! `parse_markdown_body` and `resolve_references` against the bodies the
//! composer recordings already hold as parsed: every text node's body in
//! `compose-node.jsonl`, `compose-canvas.jsonl` and `compose-comments.jsonl`
//! (resolved, as the composer's `parse_body` seam answers it) and every comment
//! message in `compose-comments.jsonl` (parsed alone, as its `parse_markdown`
//! seam answers it). Those recordings' trees are the composer's input, so this is
//! the parse the composer will make once the seam defaults to Rust.

mod mdast_support;

use std::collections::BTreeMap;

use serde_json::Value;
use whiteboard_codec::markdown::parse_markdown_body;
use whiteboard_codec::references::resolve_references;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

use mdast_support::{canonical, canonical_json};

const NODE: &str = include_str!("../../../../packages/canvas-render/src/oracle/compose-node.jsonl");
const CANVAS: &str =
    include_str!("../../../../packages/canvas-render/src/oracle/compose-canvas.jsonl");
const COMMENTS: &str =
    include_str!("../../../../packages/canvas-render/src/oracle/compose-comments.jsonl");

/// `compose-node-oracle/corpus.ts`'s `resolveAlias`.
const NODE_ALIASES: [(&str, &str); 2] =
    [("doc", "01HZX3Q8K9V2M4N5P6R7S8T9WA"), ("board", "01HZX3Q8K9V2M4N5P6R7S8T9WB")];

/// `compose-canvas-oracle/corpus.ts`'s `resolveAlias`, which the comments corpus reuses.
const CANVAS_ALIASES: [(&str, &str); 1] = [("child", "01HZX3Q8K9V2M4N5P6R7S8T9WC")];

fn table(rows: &[(&str, &str)]) -> BTreeMap<String, String> {
    rows.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

/// The meta line's `key` table: each text with its recorded tree, `null` for
/// the one text a recording makes its seam throw on.
fn recorded(recording: &str, key: &str) -> Vec<(String, Value)> {
    let meta: Value =
        serde_json::from_str(recording.lines().next().unwrap_or_default()).unwrap_or_default();
    let entries = meta.get(key).and_then(Value::as_object).cloned().unwrap_or_default();
    entries.into_iter().filter(|(_, tree)| !tree.is_null()).collect()
}

/// The texts of `key` in `recording` the port reads otherwise than recorded.
fn differing(
    recording: &str,
    key: &str,
    aliases: Option<&BTreeMap<String, String>>,
) -> Vec<String> {
    let mut out = Vec::new();
    for (text, tree) in recorded(recording, key) {
        let ours = parse_markdown_body(&text).map(|root| match aliases {
            Some(aliases) => canonical(&resolve_references(&root, aliases)),
            None => canonical(&root),
        });
        let theirs = canonical_json(&tree);
        if ours.as_deref() != Ok(theirs.as_str()) {
            out.push(format!("{text:?}\n  rust: {ours:?}\n  ts:   {theirs}"));
        }
    }
    out
}

#[test]
fn the_recordings_hold_the_bodies_the_composer_parses() {
    let counts = [
        recorded(NODE, "bodies").len(),
        recorded(CANVAS, "bodies").len(),
        recorded(COMMENTS, "bodies").len(),
        recorded(COMMENTS, "markdown").len(),
    ];
    assert!(counts.iter().all(|&n| n >= 10) && counts.iter().sum::<usize>() > 200, "{counts:?}");
}

#[test]
fn a_node_body_resolves_as_the_composer_recordings_do() {
    let node = table(&NODE_ALIASES);
    let canvas = table(&CANVAS_ALIASES);
    let mut out = differing(NODE, "bodies", Some(&node));
    out.extend(differing(CANVAS, "bodies", Some(&canvas)));
    out.extend(differing(COMMENTS, "bodies", Some(&canvas)));
    assert!(out.is_empty(), "{}", out.join("\n"));
}

#[test]
fn a_comment_parses_alone_as_the_composer_recordings_do() {
    let out = differing(COMMENTS, "markdown", None);
    assert!(out.is_empty(), "{}", out.join("\n"));
}
