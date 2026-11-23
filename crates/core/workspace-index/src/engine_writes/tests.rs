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
