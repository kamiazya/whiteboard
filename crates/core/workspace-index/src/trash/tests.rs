use super::*;
use crate::test_record::{ID_A, ID_B};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_crdt::{LoroValue, loro_value};

const DIGEST: &str = "0000000000000000000000000000000000000000000000000000000000000001";

fn blob() -> LoroValue {
    loro_value!({ "algorithm": "sha-256", "digestHex": DIGEST })
}

fn doc_with(rows: &[(&str, LoroValue)]) -> LoroDoc {
    let doc = LoroDoc::new();
    let trash = doc.get_map("trash");
    for (key, row) in rows {
        trash.insert(key, row.clone()).expect("a row is set");
    }
    doc
}

fn read(row: LoroValue) -> Vec<TrashRow> {
    read_trash_rows(&doc_with(&[(ID_A, row)]))
}

fn plain(deleted_at: i64) -> LoroValue {
    loro_value!({ "documentId": ID_A, "path": "a/b", "deletedAt": deleted_at, "blob": blob() })
}

#[test]
fn a_row_reads_with_everything_it_records() {
    let row = loro_value!({
        "documentId": ID_A,
        "path": "a/b",
        "name": "Plan",
        "folderNames": [{ "path": "a", "name": "Notes" }],
        "deletedAt": 1_700_000_000_000_i64,
        "blob": blob(),
    });
    assert_eq!(
        read(row),
        vec![TrashRow {
            document_id: ID_A.to_owned(),
            path: "a/b".to_owned(),
            name: Some("Plan".to_owned()),
            folder_names: Some(vec![("a".to_owned(), "Notes".to_owned())]),
            deleted_at: 1_700_000_000_000,
            algorithm: "sha-256".to_owned(),
            digest_hex: DIGEST.to_owned(),
        }]
    );
}

#[test]
fn name_and_folder_names_are_optional_and_a_key_this_version_does_not_know_is_set_aside() {
    let rows = read(loro_value!({
        "documentId": ID_A, "path": "a", "deletedAt": 0, "blob": blob(), "later": 1,
    }));
    assert_eq!((rows[0].name.clone(), rows[0].folder_names.clone()), (None, None));
    let named = read(loro_value!({
        "documentId": ID_A, "path": "a", "deletedAt": 0, "blob": blob(),
        "folderNames": [{ "path": "a", "name": "N", "later": true }],
    }));
    assert_eq!(named[0].folder_names, Some(vec![("a".to_owned(), "N".to_owned())]));
}

#[test]
fn a_damaged_row_is_skipped() {
    let bad_blob = |blob: LoroValue| loro_value!({ "documentId": ID_A, "path": "a", "deletedAt": 0, "blob": blob });
    let digest = |digest: &str| loro_value!({ "algorithm": "sha-256", "digestHex": digest });
    let damaged = [
        loro_value!({ "documentId": "nope", "path": "a", "deletedAt": 0, "blob": blob() }),
        loro_value!({ "documentId": ID_A, "path": "", "deletedAt": 0, "blob": blob() }),
        loro_value!({ "documentId": ID_A, "path": "a", "name": "", "deletedAt": 0, "blob": blob() }),
        loro_value!({ "documentId": ID_A, "path": "a", "name": 5, "deletedAt": 0, "blob": blob() }),
        loro_value!({ "documentId": ID_A, "path": "a", "deletedAt": -1, "blob": blob() }),
        loro_value!({ "documentId": ID_A, "path": "a", "deletedAt": 1.5, "blob": blob() }),
        loro_value!({ "documentId": ID_A, "path": "a", "deletedAt": "0", "blob": blob() }),
        loro_value!({ "documentId": ID_A, "path": "a", "deletedAt": 9_007_199_254_740_992.0, "blob": blob() }),
        loro_value!({ "documentId": ID_A, "path": "a", "deletedAt": 0 }),
        loro_value!({ "documentId": ID_A, "path": "a", "deletedAt": 0, "blob": 5 }),
        bad_blob(loro_value!({ "algorithm": "md5", "digestHex": DIGEST })),
        bad_blob(loro_value!({ "algorithm": "sha-256" })),
        bad_blob(digest("00")),
        bad_blob(digest(&"A".repeat(64))),
        bad_blob(digest(&format!("{DIGEST}0"))),
        loro_value!({
            "documentId": ID_A, "path": "a", "deletedAt": 0, "blob": blob(),
            "folderNames": [{ "path": "", "name": "N" }],
        }),
        loro_value!({
            "documentId": ID_A, "path": "a", "deletedAt": 0, "blob": blob(),
            "folderNames": [{ "path": "a", "name": "" }],
        }),
        loro_value!({
            "documentId": ID_A, "path": "a", "deletedAt": 0, "blob": blob(), "folderNames": "x",
        }),
        loro_value!("not a map"),
    ];
    for row in damaged {
        assert_eq!(read(row.clone()), Vec::new(), "{row:?}");
    }
    assert_eq!(read(plain(0)).len(), 1);
    let lower =
        loro_value!({ "algorithm": "sha-256", "digestHex": ("abcdef0123456789".repeat(4)) });
    assert_eq!(
        read(loro_value!({ "documentId": ID_A, "path": "a", "deletedAt": 0, "blob": lower })).len(),
        1
    );
}

#[test]
fn a_damaged_row_does_not_hide_the_rest() {
    let doc = doc_with(&[(ID_A, loro_value!("junk")), (ID_B, plain(5))]);
    assert_eq!(read_trash_rows(&doc).len(), 1);
}

#[test]
fn the_most_folder_names_a_row_keeps_is_a_bound() {
    let names = |count: usize| {
        let folder = |n: usize| loro_value!({ "path": (format!("a{n}")), "name": "N" });
        LoroValue::from((0..count).map(folder).collect::<Vec<_>>())
    };
    let row = |count: usize| {
        loro_value!({
            "documentId": ID_A, "path": "a", "deletedAt": 0, "blob": blob(),
            "folderNames": (names(count)),
        })
    };
    assert_eq!(read(row(256)).len(), 1);
    assert_eq!(read(row(257)).len(), 0);
}

#[test]
fn rows_come_newest_first() {
    let doc = doc_with(&[
        (ID_A, plain(100)),
        (ID_B, {
            loro_value!({ "documentId": ID_B, "path": "b", "deletedAt": 200, "blob": blob() })
        }),
    ]);
    let ids: Vec<String> = read_trash_rows(&doc).into_iter().map(|row| row.document_id).collect();
    assert_eq!(ids, vec![ID_B.to_owned(), ID_A.to_owned()]);
}

#[test]
fn a_record_with_no_trash_has_none() {
    assert_eq!(read_trash_rows(&LoroDoc::new()), Vec::new());
    let list = LoroDoc::new();
    list.get_list("trash").push(1).expect("an item is pushed");
    assert_eq!(read_trash_rows(&list), Vec::new());
}
