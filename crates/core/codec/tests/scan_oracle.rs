//! `find_next_reference` against the recorded TypeScript answers.
//!
//! `packages/codec/src/references/oracle/scan.jsonl` was written from
//! `scanReferences` and `findNextReference` and holds, for every input, each
//! match as `[index, full, isEmbed, target, alias, fragment]` and, for the
//! short ones, where the first match from every cursor starts. The TypeScript
//! counts UTF-16 units and this scanner bytes, so each answer is read through
//! the table of where the code points of the text begin in both.

use serde_json::Value;
use whiteboard_codec::references::find_next_reference;
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const RECORDING: &str = include_str!("../../../../packages/codec/src/references/oracle/scan.jsonl");

fn cases() -> Vec<Value> {
    let mut lines = RECORDING.lines().map(|l| serde_json::from_str::<Value>(l).unwrap_or_default());
    let _meta = lines.next();
    lines.collect()
}

/// `(utf16 offset, byte offset)` of every code point start, and of the end.
fn boundaries(text: &str) -> Vec<(usize, usize)> {
    let mut at = 0;
    let mut table: Vec<(usize, usize)> = text
        .char_indices()
        .map(|(byte, c)| {
            let here = (at, byte);
            at += c.len_utf16();
            here
        })
        .collect();
    table.push((at, text.len()));
    table
}

fn utf16_of(table: &[(usize, usize)], byte: usize) -> Option<usize> {
    table.iter().find(|(_, b)| *b == byte).map(|(u, _)| *u)
}

/// Every match from the start, as the recording lays one out.
fn scanned(text: &str, table: &[(usize, usize)]) -> Vec<Value> {
    let mut rows = Vec::new();
    let mut cursor = 0;
    while let Some(m) = find_next_reference(text, cursor) {
        let index = utf16_of(table, m.index);
        rows.push(Value::Array(vec![
            index.map_or(Value::Null, Value::from),
            Value::from(m.full),
            Value::from(m.is_embed),
            Value::from(m.target),
            m.alias.map_or(Value::Null, Value::from),
            m.fragment.map_or(Value::Null, Value::from),
        ]));
        cursor = m.index.saturating_add(m.full.len());
    }
    rows
}

fn text_of(case: &Value) -> &str {
    case.get("t").and_then(Value::as_str).unwrap_or_default()
}

fn id_of(case: &Value) -> &str {
    case.get("i").and_then(Value::as_str).unwrap_or_default()
}

#[test]
fn the_recording_covers_the_grammar_and_the_generator() {
    let cases = cases();
    assert!(cases.len() > 1_500, "{} cases", cases.len());
    let probed = cases.iter().filter(|c| c.get("n").is_some()).count();
    assert!(probed > 700, "{probed} cursor probes");
    let matches: usize = cases.iter().filter_map(|c| c.get("r")?.as_array()).map(Vec::len).sum();
    assert!(matches > 1_000, "{matches} matches");
}

#[test]
fn every_recorded_text_scans_as_the_typescript_scans_it() {
    let mut apart = Vec::new();
    for case in cases() {
        let text = text_of(&case);
        let ours = scanned(text, &boundaries(text));
        let theirs = case.get("r").and_then(Value::as_array).cloned().unwrap_or_default();
        if ours != theirs {
            apart.push(format!("{}: {text:?}\n  rust: {ours:?}\n  ts:   {theirs:?}", id_of(&case)));
        }
    }
    assert!(apart.is_empty(), "{} scanned apart:\n{}", apart.len(), apart.join("\n"));
}

#[test]
fn every_recorded_cursor_finds_the_first_match_as_the_typescript_does() {
    let mut apart = Vec::new();
    for case in cases() {
        let Some(probes) = case.get("n").and_then(Value::as_array) else { continue };
        let text = text_of(&case);
        let table = boundaries(text);
        for (cursor, want) in probes.iter().enumerate() {
            // A cursor inside a surrogate pair names no byte of this text.
            let Some(&(_, byte)) = table.iter().find(|(u, _)| *u == cursor) else { continue };
            let got = find_next_reference(text, byte)
                .and_then(|m| utf16_of(&table, m.index))
                .map_or(-1, |u| i64::try_from(u).unwrap_or(-2));
            if Some(got) != want.as_i64() {
                apart.push(format!("{} from {cursor}: rust {got}, ts {want}", id_of(&case)));
            }
        }
    }
    assert!(apart.is_empty(), "{} cursors apart:\n{}", apart.len(), apart.join("\n"));
}
