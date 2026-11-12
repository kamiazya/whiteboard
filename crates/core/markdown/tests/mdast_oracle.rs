//! The parser against the recorded TypeScript answers.
//!
//! `packages/codec/src/markdown/oracle/mdast.jsonl` holds what
//! `parseMarkdownBody` answered for a corpus: this repository's documents and
//! the OKF bodies in its recordings, the `CommonMark` and GFM spec examples,
//! hand-written wiki-link, embed and shortcode cases, and seeded hostile text.
//! What is compared is the model tree (`common/model.rs` makes it from this
//! crate's tree), as canonical text, by FNV-1a 64 digest, and for the sets a
//! person reads by tree too. The recording's own test fails when the
//! TypeScript stops answering as recorded; this replays it.
//!
//! The two parsers are not one dialect, so the comparison is exact except for
//! `mdast_tolerated.json`: each class names a difference that is left, why,
//! and the cases that show it. A case that differs and is not listed fails,
//! and so does a listed case that no longer differs, so the ledger only
//! shrinks. An input past a bound of this parser is refused (a refusal asks
//! the TypeScript to parse it) and is not compared: the recording marks those
//! by the id prefix its meta line names.

#[path = "common/model.rs"]
mod model;

use std::collections::BTreeSet;

use serde_json::Value;
use whiteboard_markdown::{Refusal, parse};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const RECORDING: &str = include_str!("../../../../packages/codec/src/markdown/oracle/mdast.jsonl");
const LEDGER: &str = include_str!("mdast_tolerated.json");

/// How many recorded cases the ledger tolerates. Pinned by equality, so a
/// shrunk ledger lowers it and a grown one cannot pass by itself.
const TOLERATED: usize = 87;

/// FNV-1a 64 over the UTF-8 of `text`, as 16 hex digits.
fn fnv64(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

struct Case {
    id: String,
    text: String,
    digest: String,
    tree: Option<Value>,
}

struct Recording {
    past_bound: String,
    cases: Vec<Case>,
}

fn field(line: &Value, key: &str) -> String {
    line.get(key).and_then(Value::as_str).map(str::to_string).unwrap_or_default()
}

fn recording() -> Recording {
    let mut lines =
        RECORDING.lines().map(|l| serde_json::from_str::<Value>(l).unwrap_or(Value::Null));
    let meta = lines.next().unwrap_or(Value::Null);
    let past_bound = field(&meta, "pastBound");
    let cases = lines
        .map(|line| Case {
            id: field(&line, "i"),
            text: field(&line, "t"),
            digest: field(&line, "h"),
            tree: line.get("m").cloned(),
        })
        .collect();
    Recording { past_bound, cases }
}

/// The ids of the cases this parser refused and of those it read differently.
struct Outcome {
    refused: BTreeSet<String>,
    differing: BTreeSet<String>,
    report: Vec<String>,
}

fn replay(recording: &Recording) -> Outcome {
    let mut outcome =
        Outcome { refused: BTreeSet::new(), differing: BTreeSet::new(), report: Vec::new() };
    for case in &recording.cases {
        let root = match parse(&case.text) {
            Ok(root) => root,
            Err(Refusal::TooLarge | Refusal::TooDeep | Refusal::TooCostly) => {
                outcome.refused.insert(case.id.clone());
                continue;
            }
        };
        let canonical = model::canonical(&root);
        if fnv64(&canonical) == case.digest {
            continue;
        }
        outcome.differing.insert(case.id.clone());
        if outcome.report.len() < 6 {
            let recorded =
                case.tree.as_ref().map_or_else(|| "(digest only)".to_string(), Value::to_string);
            outcome.report.push(format!(
                "{}: {:?}\n  rust: {canonical}\n  ts:   {recorded}",
                case.id, case.text
            ));
        }
    }
    outcome
}

fn ledgered() -> (BTreeSet<String>, usize) {
    let ledger: Value = serde_json::from_str(LEDGER).unwrap_or(Value::Null);
    let mut ids = BTreeSet::new();
    let mut listed = 0;
    for class in ledger.get("classes").and_then(Value::as_array).into_iter().flatten() {
        for id in class.get("cases").and_then(Value::as_array).into_iter().flatten() {
            listed += 1;
            ids.extend(id.as_str().map(str::to_string));
        }
    }
    (ids, listed)
}

#[test]
fn the_recording_is_the_corpus_the_comparison_claims() {
    let recording = recording();
    assert!(recording.cases.len() > 5_000, "{} cases", recording.cases.len());
    assert_eq!(recording.past_bound, "b");
    assert!(recording.cases.iter().all(|c| c.digest.len() == 16 && !c.id.is_empty()));
    let trees = recording.cases.iter().filter(|c| c.tree.is_some()).count();
    assert!(trees > 700, "{trees} recorded trees");
}

#[test]
fn only_the_inputs_past_a_bound_are_refused() {
    let recording = recording();
    let outcome = replay(&recording);
    let past: BTreeSet<String> = recording
        .cases
        .iter()
        .filter(|c| {
            c.id.starts_with(&recording.past_bound) && c.id[1..].bytes().all(|b| b.is_ascii_digit())
        })
        .map(|c| c.id.clone())
        .collect();
    assert!(past.len() > 4, "{} cases past a bound", past.len());
    assert_eq!(outcome.refused, past);
}

#[test]
fn every_other_case_reads_as_the_typescript_does_but_the_ledgered() {
    let (ids, listed) = ledgered();
    assert_eq!(ids.len(), listed, "a case is listed twice");
    let outcome = replay(&recording());
    let fresh: Vec<_> = outcome.differing.difference(&ids).collect();
    let stale: Vec<_> = ids.difference(&outcome.differing).collect();
    assert!(
        fresh.is_empty() && stale.is_empty(),
        "{} differ and are not in the ledger: {:?}; {} are in it and no longer differ: {:?}\n{}",
        fresh.len(),
        fresh.iter().take(20).collect::<Vec<_>>(),
        stale.len(),
        stale.iter().take(20).collect::<Vec<_>>(),
        outcome.report.join("\n")
    );
    assert_eq!(listed, TOLERATED, "lower TOLERATED when the ledger shrinks");
}

#[test]
fn every_ledgered_class_says_why_and_names_cases_that_are_recorded() {
    let ledger: Value = serde_json::from_str(LEDGER).unwrap_or(Value::Null);
    let classes = ledger.get("classes").and_then(Value::as_array).cloned().unwrap_or_default();
    assert!(classes.len() >= 4, "{} classes", classes.len());
    let recorded: BTreeSet<String> = recording().cases.into_iter().map(|c| c.id).collect();
    for class in &classes {
        assert!(field(class, "reason").len() > 60, "{} has no reason", field(class, "id"));
        assert!(!field(class, "repro").is_empty(), "{} has no repro", field(class, "id"));
        let cases = class.get("cases").and_then(Value::as_array).cloned().unwrap_or_default();
        assert!(!cases.is_empty(), "{} lists no case", field(class, "id"));
        for id in cases.iter().filter_map(Value::as_str) {
            assert!(recorded.contains(id), "{id} is not in the recording");
        }
    }
}
