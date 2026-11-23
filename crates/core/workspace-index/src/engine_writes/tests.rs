use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[test]
fn the_listed_writers_are_the_ones_answered() {
    assert!(WORKSPACE_WRITERS.iter().all(|op| writer_of(*op).is_some()));
    for op in [WriterName::WriteMarkdownBody, WriterName::SetWorkspacePinned] {
        assert!(writer_of(op).is_none(), "{op:?}");
    }
}
