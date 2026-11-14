//! `parse_markdown_body` against the recorded `parseMarkdownBody` answers.
//!
//! The same recording `whiteboard-markdown`'s `tests/mdast_oracle.rs` replays
//! through its test-only conversion, replayed here through the conversion that
//! ships. The two parsers' differences are that crate's ledger
//! (`mdast_tolerated.json`), read here as it is there: the cases that differ
//! are exactly the ledgered ones, so a conversion that moved any other case, or
//! closed a ledgered difference by accident, fails. An input past a bound of the
//! parser is refused, and those are exactly the meta line's `pastBound` ids.

#[path = "mdast_support/digest.rs"]
mod digest;
mod mdast_support;

use std::collections::BTreeSet;

use serde_json::Value;
use whiteboard_codec::markdown::parse_markdown_body;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

use digest::fnv64;
use mdast_support::canonical;

const RECORDING: &str = include_str!("../../../../packages/codec/src/markdown/oracle/mdast.jsonl");
const LEDGER: &str = include_str!("../../markdown/tests/mdast_tolerated.json");

fn field(line: &Value, key: &str) -> String {
    line.get(key).and_then(Value::as_str).map(str::to_owned).unwrap_or_default()
}

fn ledgered() -> BTreeSet<String> {
    let ledger: Value = serde_json::from_str(LEDGER).unwrap_or_default();
    let classes = ledger.get("classes").and_then(Value::as_array).cloned().unwrap_or_default();
    let cases = classes.iter().filter_map(|c| c.get("cases").and_then(Value::as_array));
    cases.flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

/// The ids refused, and those read differently from the recording.
struct Outcome {
    refused: BTreeSet<String>,
    differing: BTreeSet<String>,
    past_bound: BTreeSet<String>,
}

fn replay() -> Outcome {
    let mut lines = RECORDING.lines().map(|l| serde_json::from_str::<Value>(l).unwrap_or_default());
    let prefix = field(&lines.next().unwrap_or_default(), "pastBound");
    let mut outcome = Outcome {
        refused: BTreeSet::new(),
        differing: BTreeSet::new(),
        past_bound: BTreeSet::new(),
    };
    for case in lines {
        let id = field(&case, "i");
        let past =
            id.strip_prefix(prefix.as_str()).is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()));
        if past {
            outcome.past_bound.insert(id.clone());
        }
        match parse_markdown_body(&field(&case, "t")) {
            Err(_) => outcome.refused.insert(id),
            Ok(root) if fnv64(&canonical(&root)) != field(&case, "h") => {
                outcome.differing.insert(id)
            }
            Ok(_) => false,
        };
    }
    outcome
}

#[test]
fn the_shipped_conversion_reads_every_case_as_recorded_but_the_ledgered() {
    let outcome = replay();
    assert!(outcome.past_bound.len() > 4, "{} past a bound", outcome.past_bound.len());
    assert_eq!(outcome.refused, outcome.past_bound);
    let ledger = ledgered();
    assert!(ledger.len() > 80, "{} ledgered", ledger.len());
    let fresh: Vec<_> = outcome.differing.difference(&ledger).collect();
    let stale: Vec<_> = ledger.difference(&outcome.differing).collect();
    assert!(
        fresh.is_empty() && stale.is_empty(),
        "not ledgered: {fresh:?}; no longer differ: {stale:?}"
    );
}
