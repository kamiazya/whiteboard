//! `parse_markdown_body` and `resolve_references` against the recorded
//! TypeScript answers.
//!
//! `packages/codec/src/references/oracle/parse-body.jsonl` holds what
//! `resolveReferences(parseMarkdownBody(t), …)` answered for every arm of the
//! reference grammar and of the walk over the tree, the mdast oracle's dialect
//! cases and a seeded stream of bracket-dense text, each case twice: through the
//! meta line's alias table, and with no resolver. Replayed exactly, but for the
//! cases [`TOLERATED`] names.

#[path = "mdast_support/digest.rs"]
mod digest;
mod mdast_support;

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use whiteboard_codec::markdown::parse_markdown_body;
use whiteboard_codec::references::resolve_references;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

use digest::fnv64;
use mdast_support::{canonical, canonical_json};

const RECORDING: &str =
    include_str!("../../../../packages/codec/src/references/oracle/parse-body.jsonl");

fn field(line: &Value, key: &str) -> String {
    line.get(key).and_then(Value::as_str).map(str::to_owned).unwrap_or_default()
}

struct Recording {
    aliases: BTreeMap<String, String>,
    cases: Vec<Value>,
}

fn recording() -> Recording {
    let mut lines = RECORDING.lines().map(|l| serde_json::from_str::<Value>(l).unwrap_or_default());
    let meta = lines.next().unwrap_or_default();
    let aliases = meta
        .get("aliases")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_owned())).collect())
        .unwrap_or_default();
    Recording { aliases, cases: lines.collect() }
}

/// What a case's two answers are, as the Rust port gives them, or why not.
struct Answers {
    resolved: String,
    unresolved: String,
}

fn answers(text: &str, aliases: &BTreeMap<String, String>) -> Result<Answers, String> {
    let root = parse_markdown_body(text).map_err(|refusal| format!("refused: {refusal:?}"))?;
    Ok(Answers {
        resolved: canonical(&resolve_references(&root, aliases)),
        unresolved: canonical(&resolve_references(&root, &BTreeMap::new())),
    })
}

/// A recorded answer: its tree's canonical text where kept, else its digest.
fn agrees(ours: &str, tree: Option<&Value>, digest: &str) -> bool {
    tree.map_or_else(|| fnv64(ours) == digest, |tree| canonical_json(tree) == ours)
}

#[test]
fn the_recording_covers_the_grammar_and_the_generator() {
    let recording = recording();
    assert!(recording.cases.len() > 2_100, "{} cases", recording.cases.len());
    assert!(recording.aliases.len() > 10, "{} aliases", recording.aliases.len());
    assert!(recording.cases.iter().all(|c| !field(c, "i").is_empty()), "a line did not read");
    let trees = recording.cases.iter().filter(|c| c.get("m").is_some()).count();
    assert!(trees > 100, "{trees} hand-written cases");
}

/// The cases the two PARSERS read apart, by class, each with why. The
/// reference pass is not what differs: a class here is a difference of
/// `whiteboard-markdown` from remark, which belongs beside that crate's own
/// ledger (`mdast_tolerated.json`) once its recording holds the case. A case
/// that differs and is not listed fails, and so does a listed one that agrees.
const TOLERATED: &[(&str, &str, &[&str])] = &[(
    "D16",
    "strikethrough paired apart from strong: in `~~a**~~x**~~` micromark's strikethrough \
     resolver pairs the inner `~~` with the last before attention runs, so remark reads \
     `~~a**` then a delete of `x**`; markdown-rs resolves `~` and `*` in one delimiter pass, \
     as cmark-gfm does, and reads a delete of `a` and a strong of `~~x`",
    &["g75", "r646"],
)];

#[test]
fn every_case_resolves_as_the_typescript_does_but_the_ledgered() {
    let recording = recording();
    let mut differing = BTreeSet::new();
    let mut report = Vec::new();
    for case in &recording.cases {
        let (id, text) = (field(case, "i"), field(case, "t"));
        let agreed = answers(&text, &recording.aliases).is_ok_and(|ours| {
            agrees(&ours.resolved, case.get("m"), &field(case, "h"))
                && agrees(&ours.unresolved, case.get("u"), &field(case, "n"))
        });
        if !agreed {
            let ours = answers(&text, &recording.aliases).map(|a| a.resolved);
            report.push(format!("{id}: {text:?}\n  rust: {ours:?}\n  ts:   {:?}", case.get("m")));
            differing.insert(id);
        }
    }
    let ledgered: BTreeSet<String> =
        TOLERATED.iter().flat_map(|(_, _, ids)| ids.iter().map(|id| (*id).to_owned())).collect();
    assert!(TOLERATED.iter().all(|(_, why, ids)| why.len() > 60 && !ids.is_empty()));
    assert_eq!(differing, ledgered, "{}", report.join("\n"));
}
