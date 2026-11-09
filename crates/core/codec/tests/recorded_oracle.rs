//! The frontmatter reader and writer against the recorded TypeScript answers.
//!
//! `packages/codec/src/okf/oracle/recorded-oracle.test.ts` writes
//! `frontmatter.jsonl` from the TypeScript reader (`parseYamlKeepingWrittenIntegers`)
//! and writer (`serializeOkf`) and fails when the file no longer equals what
//! the TypeScript answers. This replays it natively, which is what lets
//! cargo-mutants and the coverage floor judge the crate by the oracle the
//! TypeScript is held to (QR-17). One JSON object per line: a reader case is
//! `{"k":"r","y":text}` with `"ok":value` or `"err":class`, a writer case
//! `{"k":"w","v":value}` with `"y":text` or `"err":"unsafe"`. A value is
//! `null`, a boolean, a string, an array, `{"f":hex}` for the bits of a
//! number, `{"big":digits}` or `{"m":[[key,value],...]}` for a mapping in the
//! order JavaScript enumerates its keys (`common`).

use serde_json::Value as Json;
use whiteboard_codec::frontmatter::{Refusal, parse, stringify};
mod common;

use common::{decode, encode};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn recording() -> Vec<Json> {
    let text = include_str!("../../../../packages/codec/src/okf/oracle/frontmatter.jsonl");
    let lines: Result<Vec<Json>, _> = text.lines().map(serde_json::from_str).collect();
    assert!(
        lines.is_ok(),
        "the recording is not one JSON value per line: {:?}",
        lines.as_ref().err()
    );
    lines.unwrap_or_default()
}

fn class_of(refusal: Refusal) -> &'static str {
    match refusal {
        Refusal::Syntax(_) | Refusal::TooLarge => "syntax",
        Refusal::Anchor => "anchor",
        Refusal::Depth => "depth",
        Refusal::Subset(_) => "subset",
    }
}

/// How the Rust reader's answer stands against the recorded one.
fn verdict(case: &Json) -> String {
    let text = case["y"].as_str().unwrap_or_default();
    match (parse(text), case.get("ok"), case.get("err").and_then(Json::as_str)) {
        (Ok(value), Some(ok), _) if &encode(&value) == ok => "value".to_string(),
        (Ok(_), Some(_), _) => format!("a different value: {text:?}"),
        (Ok(_), None, err) => format!("accepted, refused by the TypeScript as {err:?}: {text:?}"),
        (Err(r), None, Some(err)) if class_of(r) == err => format!("refusal as {err}"),
        (Err(r), None, err) => format!("refused as {r:?}, by the TypeScript as {err:?}: {text:?}"),
        (Err(r), Some(_), _) => format!("refused ({r:?}), read by the TypeScript: {text:?}"),
    }
}

#[test]
fn every_recorded_text_is_read_as_the_typescript_read_it() {
    let recording = recording();
    let cases: Vec<&Json> = recording.iter().filter(|c| c["k"] == "r").collect();
    let verdicts: Vec<String> = cases.iter().map(|case| verdict(case)).collect();
    let agreed = |v: &String| v == "value" || v.starts_with("refusal as ");
    let disagreements: Vec<&String> = verdicts.iter().filter(|v| !agreed(v)).collect();
    assert!(
        disagreements.is_empty(),
        "{} of {} texts disagree, the first: {:#?}",
        disagreements.len(),
        cases.len(),
        &disagreements[..disagreements.len().min(10)]
    );
    // An agreement over nothing passes, so say what the recording reached.
    let count = |what: &str| verdicts.iter().filter(|v| v.as_str() == what).count();
    assert!(cases.len() > 2500, "{} recorded texts", cases.len());
    assert!(count("value") > 1500, "{} texts read to a value", count("value"));
    for class in ["anchor", "depth", "subset", "syntax"] {
        let refused = count(&format!("refusal as {class}"));
        assert!(refused > 8, "{refused} texts refused as {class}");
    }
}

#[test]
fn every_recorded_value_is_written_as_the_typescript_wrote_it() {
    let recording = recording();
    let cases: Vec<&Json> = recording.iter().filter(|c| c["k"] == "w").collect();
    let mut problems: Vec<String> = Vec::new();
    let (mut written, mut unwritable) = (0usize, 0usize);
    for case in &cases {
        let answer =
            stringify(&decode(&case["v"]).expect("a recorded writer value is representable"));
        match (answer, case.get("y").and_then(Json::as_str), case.get("err")) {
            (Ok(text), Some(y), _) if text == y => written += 1,
            (Err(_), None, Some(_)) => unwritable += 1,
            (answer, y, _) => {
                problems.push(format!("rust {answer:?}, typescript {y:?}, for {}", case["v"]));
            }
        }
    }
    assert!(
        problems.is_empty(),
        "{} of {} values disagree, the first: {:#?}",
        problems.len(),
        cases.len(),
        &problems[..problems.len().min(5)]
    );
    assert!(written > 900, "{written} values written");
    assert!(unwritable > 5, "{unwritable} values refused");
}
