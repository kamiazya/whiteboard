//! The history mechanics against the recorded answers of the TypeScript.
//!
//! `packages/history/src/oracle/crdt-mechanics.jsonl` is that recording,
//! frozen. This replays what is plain values: the retention passes, the
//! restore options, the constants, and the base64 half of the frontier rows.
//! A frontier is a point in the op log and its bytes are the CRDT engine's
//! encoding, so the rows that turn one into a version vector (`compactionCut`)
//! or into bytes, and the refusals the engine makes of well-formed base64, are
//! counted and skipped by op. Both ledgers pin the rows by op, so a recorder
//! change that drops or adds rows fails here.

#![cfg(test)]

use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_history::{
    CHECKPOINT_QUIET_MS, LineageCandidate, MAX_AUTO_PER_DOCUMENT, MAX_MANUAL_PER_DOCUMENT,
    MAX_RESTORE_POINTS_PER_DOCUMENT, SandwichCandidate, auto_versions_over_cap,
    carried_auto_versions_over_cap, frontiers_from_base64, frontiers_to_base64,
    restore_point_options, sandwiched_auto_version_ids,
};

const RECORDING: &str =
    include_str!("../../../../packages/history/src/oracle/crdt-mechanics.jsonl");

/// The ops replayed here, with the rows replayed of each. The two frontier ops
/// replay the base64 half only: the recorded text against the bytes it spells.
const REPLAYED: &[(&str, usize)] = &[
    ("autoVersionsOverCap", 41),
    ("carriedAutoVersionsOverCap", 40),
    ("sandwichedAutoVersionIds", 40),
    ("restorePointOptions", 3),
    ("constants", 1),
    ("frontiersToBase64", 20),
    ("frontiersFromBase64", 29),
];

/// The ops with rows the port does not answer, with those rows. Each needs the
/// engine: `compactionCut` reads a snapshot's op log to turn frontiers into
/// version vectors, and a refused `frontiersFromBase64` row is base64 the
/// engine does not read as frontiers.
const DEFERRED: &[(&str, usize)] = &[("compactionCut", 220), ("frontiersFromBase64", 3)];

fn candidates(row: &Json) -> Vec<LineageCandidate> {
    row["autos"].as_array().map(|autos| autos.iter().map(lineage).collect()).unwrap_or_default()
}

fn lineage(entry: &Json) -> LineageCandidate {
    LineageCandidate {
        id: entry["id"].as_str().unwrap_or_default().to_owned(),
        restored_from: entry["restoredFrom"].as_str().map(str::to_owned),
    }
}

fn set_of(row: &Json, key: &str) -> BTreeSet<String> {
    row[key]
        .as_array()
        .map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

fn cap_of(row: &Json) -> usize {
    row.get("cap")
        .and_then(Json::as_u64)
        .map_or(MAX_AUTO_PER_DOCUMENT, |cap| usize::try_from(cap).expect("a cap"))
}

fn ok(value: impl Into<Json>) -> Json {
    json!({ "ok": value.into() })
}

fn text_answer(row: &Json) -> Option<Json> {
    let text = row["result"]["ok"].as_str()?;
    let bytes = frontiers_from_base64(text).ok()?;
    Some(ok(frontiers_to_base64(&bytes)))
}

fn bytes_answer(row: &Json) -> Option<Json> {
    let recorded_ok = row["result"].get("ok").is_some();
    match frontiers_from_base64(row["text"].as_str()?) {
        Ok(_) if recorded_ok => Some(row["result"].clone()),
        Ok(_) => None,
        Err(refusal) => {
            assert_eq!(refusal.to_string(), "frontiers are not base64");
            Some(json!({ "err": "Error" }))
        }
    }
}

fn answer(row: &Json) -> Option<Json> {
    Some(match row["op"].as_str()? {
        "autoVersionsOverCap" => {
            ok(auto_versions_over_cap(&candidates(row), &set_of(row, "referenced"), cap_of(row)))
        }
        "carriedAutoVersionsOverCap" => ok(carried_auto_versions_over_cap(
            &candidates(row),
            &set_of(row, "carried"),
            &set_of(row, "referenced"),
            cap_of(row),
        )),
        "sandwichedAutoVersionIds" => {
            let rows: Vec<SandwichCandidate> = row["candidates"]
                .as_array()?
                .iter()
                .map(|entry| SandwichCandidate {
                    row: lineage(entry),
                    auto: entry["auto"].as_bool().unwrap_or(false),
                })
                .collect();
            ok(sandwiched_auto_version_ids(&rows))
        }
        "restorePointOptions" => {
            let options = restore_point_options(row["restoredFrom"].as_str()?);
            ok(json!({ "auto": options.auto, "restoredFrom": options.restored_from }))
        }
        "constants" => ok(json!({
            "MAX_AUTO_PER_DOCUMENT": MAX_AUTO_PER_DOCUMENT,
            "MAX_MANUAL_PER_DOCUMENT": MAX_MANUAL_PER_DOCUMENT,
            "MAX_RESTORE_POINTS_PER_DOCUMENT": MAX_RESTORE_POINTS_PER_DOCUMENT,
            "CHECKPOINT_QUIET_MS": CHECKPOINT_QUIET_MS,
        })),
        "frontiersToBase64" => return text_answer(row),
        "frontiersFromBase64" => return bytes_answer(row),
        _ => return None,
    })
}

#[test]
fn every_pure_row_is_answered_as_the_typescript_answered_it() {
    let mut replayed: BTreeMap<String, usize> = BTreeMap::new();
    let mut deferred: BTreeMap<String, usize> = BTreeMap::new();
    for line in RECORDING.lines() {
        let row: Json = serde_json::from_str(line).expect("a recorded line");
        let op = row["op"].as_str().expect("an op").to_owned();
        match answer(&row) {
            Some(got) => {
                assert_eq!(got, row["result"], "{} ({})", row["id"], row["tag"]);
                *replayed.entry(op).or_default() += 1;
            }
            None => *deferred.entry(op).or_default() += 1,
        }
    }
    let ledger = |rows: &[(&str, usize)]| -> BTreeMap<String, usize> {
        rows.iter().map(|&(op, n)| (op.to_owned(), n)).collect()
    };
    assert_eq!(replayed, ledger(REPLAYED), "the rows replayed, by op");
    assert_eq!(deferred, ledger(DEFERRED), "the rows deferred to the CRDT engine, by op");
}
