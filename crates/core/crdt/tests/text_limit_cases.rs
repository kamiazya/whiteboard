//! The text-limit judge of a document's state over the arrangements the
//! recording lacks: the recording's documents hold no breach but a few
//! retired shapes, so every other bound is held here, each at its ceiling and
//! one past it, under a document's own root and under a workspace tree node,
//! and where two bounds break at once, the one the TypeScript names.
//!
//! `fixtures/text_limit_cases.jsonl` holds each document as its snapshot
//! bytes and what the TypeScript engine answered for `textLimitBreach` and
//! `documentJudgement` over them. A snapshot rather than steps, because the
//! judge reads the history that built the state: the order of the ops, the
//! containers they created and a write into a container its change never saw
//! created are each part of the case.

#[cfg(test)]
#[expect(dead_code, reason = "the shared helpers are each used by some of the recordings' tests")]
mod support;

use serde_json::Value as Json;
use std::collections::BTreeSet;
use support::{assert_same, base64_decode, model_of, rows_of};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{
    BreachShape, answer_content_query, deep_value, import_bytes, judge_state, version_pairs,
};
use whiteboard_model::crdt::{Query, QueryName};

const CASES: &str = include_str!("fixtures/text_limit_cases.jsonl");
const REFUSALS: &str = include_str!("../../../../contracts/api/refusals.json");

/// The shapes a state cannot break: an insert run costs nothing when a state
/// is loaded into an empty document, so the judge of a state judges none.
const NOT_REACHED_BY_A_STATE: [BreachShape; 2] = [BreachShape::Run, BreachShape::Runs];

#[cfg(test)]
fn answer(bytes: &[u8], query: QueryName) -> whiteboard_model::Value {
    let doc = import_bytes(bytes).expect("the recorded bytes import");
    answer_content_query(&doc, &Query { query, args: None }).expect("answered").value
}

#[test]
fn every_case_is_judged_as_the_typescript_judged_it() {
    let rows = rows_of(CASES);
    assert!(rows.len() > 100, "{} cases", rows.len());
    for row in &rows {
        let name = row["name"].as_str().expect("a name");
        let bytes = base64_decode(row["bytes"].as_str().expect("bytes"));
        for (query, field) in [
            (QueryName::TextLimitBreach, "textLimitBreach"),
            (QueryName::DocumentJudgement, "documentJudgement"),
        ] {
            assert_same(&format!("{name} {field}"), &answer(&bytes, query), &model_of(&row[field]));
        }
    }
}

#[test]
fn every_shape_a_state_can_break_has_a_case_and_a_case_under_its_ceiling() {
    let rows = rows_of(CASES);
    let named: BTreeSet<&str> =
        rows.iter().filter_map(|row| row["textLimitBreach"]["ok"]["shape"].as_str()).collect();
    for shape in BreachShape::ALL {
        let reached = named.contains(shape.wire());
        assert_eq!(reached, !NOT_REACHED_BY_A_STATE.contains(&shape), "{}", shape.wire());
    }
    let kept = rows.iter().filter(|row| row["textLimitBreach"]["ok"].is_null()).count();
    assert!(kept > 30, "{kept} cases the judge keeps");
}

#[test]
fn a_long_paste_deleted_back_is_no_run_in_a_state() {
    let rows = rows_of(CASES);
    let row =
        rows.iter().find(|row| row["name"] == "body_long_run_deleted_back").expect("the case");
    let doc = import_bytes(&base64_decode(row["bytes"].as_str().expect("bytes"))).expect("imports");
    assert_eq!(judge_state(&doc), Ok(None));
}

#[test]
fn judging_leaves_the_document_as_it_was() {
    for row in rows_of(CASES).iter().filter(|row| !row["textLimitBreach"]["ok"].is_null()) {
        let doc =
            import_bytes(&base64_decode(row["bytes"].as_str().expect("bytes"))).expect("imports");
        let (deep, versions) = (deep_value(&doc), version_pairs(&doc));
        judge_state(&doc).expect("judged");
        assert_eq!(deep_value(&doc), deep, "{} deep value", row["name"]);
        assert_eq!(version_pairs(&doc), versions, "{} versions", row["name"]);
    }
}

#[test]
fn each_shape_is_refused_with_the_code_the_contract_gives_it() {
    let contract: Json = serde_json::from_str(REFUSALS).expect("the contract");
    let entries = contract["refusals"].as_array().expect("refusals");
    for shape in BreachShape::ALL {
        let codes: BTreeSet<&str> = entries
            .iter()
            .filter(|entry| {
                entry["breach"]["table"] == "text" && entry["breach"]["shape"] == shape.wire()
            })
            .filter_map(|entry| entry["code"].as_str())
            .collect();
        assert_eq!(codes, BTreeSet::from([shape.code()]), "{}", shape.wire());
    }
    let text_shapes = entries
        .iter()
        .filter(|entry| entry["breach"]["table"] == "text")
        .filter_map(|entry| entry["breach"]["shape"].as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(text_shapes, BreachShape::ALL.iter().map(|shape| shape.wire()).collect());
}
