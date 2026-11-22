//! The history mechanics against the recorded answers of the TypeScript.
//!
//! `packages/history/src/oracle/crdt-mechanics.jsonl` is that recording,
//! frozen. This replays every row: the retention passes, the restore options,
//! the constants, and the rows that need the CRDT engine, which read the
//! document's bytes through `whiteboard-crdt` (the compaction cut) or encode
//! and decode frontiers with it. The ledgers pin the rows by op, so a recorder
//! change that drops or adds rows fails here.

#![cfg(test)]

use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{decode_frontiers, encode_frontiers, import_bytes};
use whiteboard_history::{
    CHECKPOINT_QUIET_MS, LineageCandidate, MAX_AUTO_PER_DOCUMENT, MAX_MANUAL_PER_DOCUMENT,
    MAX_RESTORE_POINTS_PER_DOCUMENT, SandwichCandidate, auto_versions_over_cap,
    carried_auto_versions_over_cap, compaction_cut_over_doc, frontiers_from_base64,
    frontiers_to_base64, restore_point_options, sandwiched_auto_version_ids,
};
use whiteboard_model::encoding::base64_to_bytes;

const RECORDING: &str =
    include_str!("../../../../packages/history/src/oracle/crdt-mechanics.jsonl");

/// The ops replayed here, with the rows replayed of each.
const REPLAYED: &[(&str, usize)] = &[
    ("autoVersionsOverCap", 41),
    ("carriedAutoVersionsOverCap", 40),
    ("sandwichedAutoVersionIds", 40),
    ("restorePointOptions", 3),
    ("constants", 1),
    ("frontiersToBase64", 20),
    ("frontiersFromBase64", 32),
    ("compactionCut", 220),
];

/// The ops with rows the port does not answer, with those rows.
const DEFERRED: &[(&str, usize)] = &[];

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

fn pairs_of(json: &Json) -> Option<Vec<(String, i64)>> {
    json.as_array()?
        .iter()
        .map(|pair| Some((pair[0].as_str()?.to_owned(), pair[1].as_i64()?)))
        .collect()
}

fn pairs_json(pairs: &[(String, i64)]) -> Json {
    Json::Array(pairs.iter().map(|(peer, counter)| json!([peer, counter])).collect())
}

fn text_answer(row: &Json) -> Option<Json> {
    let bytes = encode_frontiers(&pairs_of(&row["frontiers"])?).ok()?;
    Some(ok(frontiers_to_base64(&bytes)))
}

fn bytes_answer(row: &Json) -> Option<Json> {
    match frontiers_from_base64(row["text"].as_str()?) {
        Ok(bytes) => Some(
            decode_frontiers(&bytes)
                .map_or_else(|_| json!({ "err": "Error" }), |pairs| ok(pairs_json(&pairs))),
        ),
        Err(refusal) => {
            assert_eq!(refusal.to_string(), "frontiers are not base64");
            Some(json!({ "err": "Error" }))
        }
    }
}

fn cut_answer(row: &Json) -> Option<Json> {
    let doc = import_bytes(&base64_to_bytes(row["doc"].as_str()?)?).ok()?;
    let points: Vec<Vec<(String, i64)>> =
        row["points"].as_array()?.iter().map(pairs_of).collect::<Option<_>>()?;
    Some(ok(compaction_cut_over_doc(&doc, &points).map_or(Json::Null, |cut| pairs_json(&cut))))
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
        "compactionCut" => return cut_answer(row),
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
    assert_eq!(deferred, ledger(DEFERRED), "the rows deferred, by op");
}
