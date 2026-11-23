use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[test]
fn the_listed_writers_are_the_ones_answered() {
    assert!(WORKSPACE_WRITERS.iter().all(|op| writer_of(*op).is_some()));
    assert!(writer_of(WriterName::WriteMarkdownBody).is_none());
}

#[test]
fn only_a_writer_of_the_planes_beside_the_tree_leaves_the_tree_unopened() {
    let beside = [
        WriterName::SetWorkspaceLastCompactedAt,
        WriterName::SetWorkspacePinned,
        WriterName::RecordTrashEntry,
        WriterName::ForgetTrashEntry,
    ];
    for op in WORKSPACE_WRITERS {
        let (_, opens_tree) = writer_of(*op).expect("a writer");
        assert_eq!(opens_tree, !beside.contains(op), "{op:?}");
    }
}

/// A `since` pair the TypeScript's `versionOfPairs` would hand loro unread: a
/// peer that is not plain decimal digits, or a counter outside `0..=i32::MAX`,
/// is not answered here, while a plain one is.
#[test]
fn a_since_pair_loro_would_not_read_is_not_answered() {
    let empty = LoroDoc::new().export(whiteboard_crdt::ExportMode::Snapshot).expect("bytes");
    let stamp = |peer: &str, counter: f64| {
        let pair = Value::Seq(vec![Value::String(peer.to_owned()), Value::Number(counter)]);
        let args = Value::Map(vec![("since".to_owned(), Value::Seq(vec![pair]))]);
        let write = Write { op: WriterName::StampEditedDocuments, args };
        write_workspace_batch(&empty, 1, &[write], WriteJudge::None, 0.0).is_some()
    };
    assert!(stamp("1", 0.0), "a plain pair");
    assert!(!stamp("+1", 0.0), "a signed peer");
    assert!(!stamp("1", -1.0), "a negative counter");
}
