//! What the recording cannot show of a workspace edit: an id minted from a
//! time no ULID spells, an alias that spells a live document's id, and the
//! full stop a quoted refusal loses.

use super::create::document_id;
use super::follow::retired_aliases;
use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_workspace_index::DocumentEntry;

fn entry(document_id: &str, path: &str) -> DocumentEntry {
    DocumentEntry {
        document_id: document_id.to_owned(),
        path: path.to_owned(),
        name: None,
        kind: None,
        updated_at: None,
        shadowed: None,
        content_digest: String::new(),
    }
}

#[test]
fn an_id_spells_the_time_most_significant_first_then_each_byte_modulo_the_alphabet() {
    let bytes: Vec<u8> = (0u8..16).map(|n| n.wrapping_mul(33)).collect();
    assert_eq!(
        document_id(1_795_521_600_000.0, &bytes).as_deref(),
        Some("01M86PTPG00123456789ABCDEF"),
    );
    assert_eq!(document_id(0.0, &[31]).as_deref(), Some("0000000000Z"));
    assert_eq!(document_id(32.0, &[]).as_deref(), Some("0000000010"));
}

#[test]
fn a_time_no_ulid_spells_mints_no_id() {
    assert_eq!(document_id(0.5, &[0]), None);
    assert_eq!(document_id(-1.0, &[0]), None);
    assert_eq!(document_id(f64::NAN, &[0]), None);
}

#[test]
fn a_move_retires_the_paths_it_carried_and_no_path_that_spells_a_live_id() {
    let live = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let before = [
        entry("01ARZ3NDEKTSV4RRFFQ69G5FA1", "a"),
        entry("01ARZ3NDEKTSV4RRFFQ69G5FA2", "a/b"),
        entry("01ARZ3NDEKTSV4RRFFQ69G5FA3", "ab"),
        entry(live, "c"),
        entry("01ARZ3NDEKTSV4RRFFQ69G5FA4", &format!("a/{live}")),
        entry("01ARZ3NDEKTSV4RRFFQ69G5FA5", live),
    ];
    let retired: Vec<String> = retired_aliases(&before, "a").into_iter().collect();
    assert_eq!(retired, ["a", &format!("a/{live}"), "a/b"]);
    assert!(retired_aliases(&before, live).is_empty());
}

#[test]
fn a_quoted_refusal_loses_one_final_full_stop() {
    assert_eq!(sentence_without_stop("Choose another."), "Choose another");
    assert_eq!(sentence_without_stop("Wait.."), "Wait.");
    assert_eq!(sentence_without_stop("No stop"), "No stop");
}

#[test]
fn each_op_is_named_by_its_discriminator() {
    let ops = [
        (WorkspaceOp::CreateSpatial { path: "a".into(), name: None }, "document.create"),
        (WorkspaceOp::CreateMarkdown, "document.create"),
        (WorkspaceOp::Set, "document.set"),
        (WorkspaceOp::Move { document_id: "d".into(), path: None, name: None }, "document.move"),
        (WorkspaceOp::Delete { document_id: "d".into() }, "document.delete"),
        (WorkspaceOp::FolderRename { path: "a".into(), name: None }, "folder.rename"),
    ];
    for (op, name) in ops {
        assert_eq!(op.name(), name);
    }
}
