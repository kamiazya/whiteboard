//! `parse_markdown_block_lines` against the block lines the TypeScript
//! recorded (the `l` field of `mdast.jsonl`'s cases).
//!
//! Three kinds of difference are expected, and nothing else:
//!
//! - an input past a bound of the parser, which the TypeScript (no bounds)
//!   reads and the Rust draws as one paragraph at line one: exactly the meta
//!   line's `pastBound` ids, skipped;
//! - a case the parsers read differently (`whiteboard-markdown`'s own ledger
//!   `mdast_tolerated.json`), whose block count or lines may then differ;
//! - [`LINE_QUIRKS`], where the trees agree and the TypeScript's position is
//!   the wrong one.
//!
//! Both ledgers are guarded from both sides: a quirk that stopped differing
//! fails, so an entry cannot outlive the difference it names.

use std::collections::BTreeSet;

use serde_json::Value;
use whiteboard_codec::markdown::parse_markdown_block_lines;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const RECORDING: &str = include_str!("../../../../packages/codec/src/markdown/oracle/mdast.jsonl");
const LEDGER: &str = include_str!("../../markdown/tests/mdast_tolerated.json");

/// Same tree, different line: remark places the setext heading `bar\n===` that
/// follows a definition on the definition's line (`cm#215` records it at 1,
/// the heading's own first line is 2).
const LINE_QUIRKS: [&str; 1] = ["cm#215"];

fn ledgered() -> BTreeSet<String> {
    let ledger: Value = serde_json::from_str(LEDGER).unwrap_or(Value::Null);
    let classes = ledger.get("classes").and_then(Value::as_array).cloned().unwrap_or_default();
    let cases = classes.iter().filter_map(|c| c.get("cases").and_then(Value::as_array));
    cases.flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

#[test]
fn every_recorded_input_has_the_lines_the_typescript_answered() {
    let mut rows =
        RECORDING.lines().map(|l| serde_json::from_str::<Value>(l).unwrap_or(Value::Null));
    let prefix = rows
        .next()
        .and_then(|meta| meta.get("pastBound").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    let mut compared = 0_usize;
    let mut differing = BTreeSet::new();
    let mut report = Vec::new();
    for case in rows {
        let id = case.get("i").and_then(Value::as_str).unwrap_or_default();
        let text = case.get("t").and_then(Value::as_str).unwrap_or_default();
        let recorded: Option<Vec<u64>> = case
            .get("l")
            .and_then(Value::as_array)
            .map(|l| l.iter().filter_map(Value::as_u64).collect());
        assert!(recorded.is_some(), "{id}: no recorded lines");
        let past = id
            .strip_prefix(prefix.as_str())
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
        if past {
            continue;
        }
        compared += 1;
        let ours: Vec<u64> =
            parse_markdown_block_lines(text).into_iter().map(|n| n as u64).collect();
        if Some(&ours) != recorded.as_ref() {
            differing.insert(id.to_owned());
            report.push(format!("{id}: {text:?}\n  rust {ours:?}\n  ts   {recorded:?}"));
        }
    }
    assert!(compared > 5_000, "{compared} inputs compared");
    let tolerated: BTreeSet<String> =
        ledgered().into_iter().chain(LINE_QUIRKS.map(str::to_owned)).collect();
    let unexplained: Vec<&String> = differing.difference(&tolerated).collect();
    assert!(unexplained.is_empty(), "unexplained: {unexplained:?}\n{}", report.join("\n"));
    for quirk in LINE_QUIRKS {
        assert!(differing.contains(quirk), "{quirk} no longer differs; drop it from LINE_QUIRKS");
    }
}
