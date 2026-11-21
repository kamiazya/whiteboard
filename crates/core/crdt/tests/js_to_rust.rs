//! JavaScript to Rust: the bytes npm `loro-crdt` exported, imported by the
//! Rust `loro` crate, answer the deep value, version vector and frontiers the
//! TypeScript recorded. Compared by value, never by snapshot bytes, which are
//! not canonical (ADR-0054 seam 6).
//!
#[cfg(test)]
mod support;

use loro::ExportMode;
use serde_json::Value as Json;
use support::{assert_same, base64_decode, model_of, pairs_of, rows_of, without_proto};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{deep_value, frontier_pairs, import_bytes, version_pairs};

const READ: &str = include_str!("../../../../packages/loro-adapter/src/oracle/crdt-read.jsonl");
const WRITE: &str = include_str!("../../../../packages/loro-adapter/src/oracle/crdt-write.jsonl");

#[cfg(test)]
fn bytes(row: &Json, field: &str) -> Vec<u8> {
    base64_decode(row[field].as_str().unwrap_or_else(|| panic!("{field} bytes")))
}

#[test]
fn every_recorded_read_row_imports_to_the_recorded_state() {
    let rows = rows_of(READ);
    assert!(rows.len() > 300, "the recording held {} rows", rows.len());
    let mut proto_rows = 0_usize;
    for row in &rows {
        let id = row["id"].as_str().expect("an id");
        for export in ["snapshot", "updates", "shallow"] {
            let doc =
                import_bytes(&bytes(row, export)).unwrap_or_else(|e| panic!("{id} {export}: {e}"));
            let recorded = if row["deep"][export].is_null() {
                &row["deep"]["updates"]
            } else {
                &row["deep"][export]
            };
            let (actual, had_proto) = without_proto(&deep_value(&doc));
            proto_rows += usize::from(had_proto);
            assert_same(&format!("{id} {export} deep value"), &actual, &model_of(recorded));
            assert_eq!(
                frontier_pairs(&doc),
                pairs_of(&row["frontiers"]),
                "{id} {export} frontiers"
            );
            if export != "shallow" {
                assert_eq!(
                    version_pairs(&doc),
                    pairs_of(&row["vv"]),
                    "{id} {export} version vector"
                );
            }
        }
    }
    assert!(
        proto_rows > 0,
        "no row held a `__proto__` key, so the guard that tolerates its absence from the recording reached nothing"
    );
}

#[test]
fn every_recorded_write_row_applies_to_the_recorded_state() {
    let rows = rows_of(WRITE);
    assert!(rows.len() > 500, "the recording held {} rows", rows.len());
    let mut applied = 0_usize;
    for row in &rows {
        let id = row["id"].as_str().expect("an id");
        let doc =
            import_bytes(&bytes(row, "before")).unwrap_or_else(|e| panic!("{id} before: {e}"));
        doc.import(&bytes(row, "update")).unwrap_or_else(|e| panic!("{id} update: {e}"));
        // The recording's `deep` is a fresh document that imported the whole
        // history, which shows a root container only when an op names it; the
        // document that replayed `before` and then `update` may also know the
        // roots `before` carried empty.
        let whole =
            doc.export(ExportMode::all_updates()).unwrap_or_else(|e| panic!("{id} export: {e}"));
        let fresh = import_bytes(&whole).unwrap_or_else(|e| panic!("{id} whole: {e}"));
        assert_same(&format!("{id} deep value"), &deep_value(&fresh), &model_of(&row["deep"]));
        assert_eq!(frontier_pairs(&doc), pairs_of(&row["frontiers"]), "{id} frontiers");
        assert_eq!(version_pairs(&doc), pairs_of(&row["vv"]), "{id} version vector");
        applied += 1;
    }
    assert_eq!(applied, rows.len());
}
