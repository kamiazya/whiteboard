//! `markdown_excerpt` against the recorded rail excerpts (the `x` field of
//! `mdast.jsonl`'s cases), taken from the TypeScript `commentExcerpt` walk.
//!
//! Two kinds of difference are expected, and nothing else:
//!
//! - an input past a bound of the parser, which the TypeScript (no bounds)
//!   reads and the Rust answers with its trimmed source: exactly the meta
//!   line's `pastBound` ids, skipped;
//! - a case the parsers read differently (`whiteboard-markdown`'s own ledger
//!   `mdast_tolerated.json`), whose excerpt then follows the tree it was read
//!   from. The excerpt adds no difference of its own: every differing case is
//!   in that ledger.

use std::collections::BTreeSet;

use serde_json::Value;
use whiteboard_codec::markdown::markdown_excerpt;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const LEDGER: &str = include_str!("../../markdown/tests/mdast_tolerated.json");
const RECORDING: &str = include_str!("../../../../packages/codec/src/markdown/oracle/mdast.jsonl");

fn ledgered() -> BTreeSet<String> {
    let ledger: Value = serde_json::from_str(LEDGER).unwrap_or(Value::Null);
    let classes = ledger.get("classes").and_then(Value::as_array).cloned().unwrap_or_default();
    let cases = classes.iter().filter_map(|c| c.get("cases").and_then(Value::as_array));
    cases.flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

#[test]
fn every_recorded_input_has_the_excerpt_the_typescript_answered() {
    let mut rows =
        RECORDING.lines().map(|l| serde_json::from_str::<Value>(l).unwrap_or(Value::Null));
    let prefix = rows
        .next()
        .and_then(|meta| meta.get("pastBound").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    let mut compared = 0_usize;
    let tolerated = ledgered();
    let mut report = Vec::new();
    for case in rows {
        let id = case.get("i").and_then(Value::as_str).unwrap_or_default();
        let text = case.get("t").and_then(Value::as_str).unwrap_or_default();
        let recorded = case.get("x").and_then(Value::as_str);
        assert!(recorded.is_some(), "{id}: no recorded excerpt");
        let past = id
            .strip_prefix(prefix.as_str())
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
        if past {
            continue;
        }
        compared += 1;
        let ours = markdown_excerpt(text);
        if Some(ours.as_str()) != recorded && !tolerated.contains(id) {
            report.push(format!("{id}: {text:?}\n  rust {ours:?}\n  ts   {recorded:?}"));
        }
    }
    assert!(compared > 5_000, "{compared} inputs compared");
    assert!(report.is_empty(), "{} differ:\n{}", report.len(), report.join("\n"));
}
