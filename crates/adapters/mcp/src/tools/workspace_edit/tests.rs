//! What the recording cannot show of the binding: how an op the SDK passed
//! reaches the operation (the arms that answer pending alike cannot be told
//! apart by a call), and the body bound, which no recorded call reaches.

use serde_json::json;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

use super::*;

#[test]
fn each_op_reaches_the_operation_as_its_own_arm() {
    let spatial = json!({ "op": "document.create", "path": "a", "kind": "spatial", "name": "A" });
    let markdown = json!({ "op": "document.create", "path": "a", "kind": "markdown" });
    let set = json!({ "op": "document.set", "documentId": "d", "markdown": "x" });
    let delete = json!({ "op": "document.delete", "documentId": "d" });
    let folder = json!({ "op": "folder.rename", "path": "f" });
    let moved = json!({ "op": "document.move", "documentId": "d", "path": "p" });
    assert_eq!(
        op_of(&spatial),
        WorkspaceOp::CreateSpatial { path: "a".into(), name: Some("A".into()) }
    );
    assert_eq!(op_of(&markdown), WorkspaceOp::CreateMarkdown);
    assert_eq!(op_of(&set), WorkspaceOp::Set);
    assert_eq!(op_of(&delete), WorkspaceOp::Delete { document_id: "d".into() });
    assert_eq!(op_of(&folder), WorkspaceOp::FolderRename { path: "f".into(), name: None });
    assert_eq!(
        op_of(&moved),
        WorkspaceOp::Move { document_id: "d".into(), path: Some("p".into()), name: None }
    );
}

#[test]
fn a_body_is_refused_past_the_markdown_bound_and_not_at_it() {
    // `MARKDOWN_MAX_CHARS`, written out so the test does not read the bound
    // it holds.
    let at_bound = json!("x".repeat(262_144));
    let past = json!("x".repeat(262_145));
    assert!(markdown_issues("ops.0.markdown", Some(&at_bound)).is_empty());
    assert_eq!(
        markdown_issues("ops.0.markdown", Some(&past)),
        [format!("ops.0.markdown: {MARKDOWN_TOO_LONG}")]
    );
}
