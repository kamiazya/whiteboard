//! What a `[[…]]` means once resolved, for the two readings the recorded
//! `parse-body.jsonl` replay does not name: a retired scheme has no meaning of
//! its own, and an id is read as an id before any table is asked.

use std::collections::BTreeMap;

use whiteboard_codec::references::resolve_references;
use whiteboard_model::mdast::{Flow, Phrasing, Root};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

fn paragraph(text: &str) -> Root {
    Root {
        children: vec![Flow::Paragraph { children: vec![Phrasing::Text { value: text.into() }] }],
    }
}

fn inline(root: &Root) -> &[Phrasing] {
    match root.children.as_slice() {
        [Flow::Paragraph { children }] => children,
        other => unreachable!("expected one paragraph, got {other:?}"),
    }
}

#[test]
fn the_retired_canvas_scheme_stays_the_literal_text_the_author_typed() {
    let aliases = BTreeMap::new();
    let resolved = resolve_references(&paragraph(&format!("see [[canvas:{ULID}]] here")), &aliases);
    assert_eq!(
        inline(&resolved),
        [
            Phrasing::Text { value: "see ".into() },
            Phrasing::Text { value: format!("[[canvas:{ULID}]]") },
            Phrasing::Text { value: " here".into() },
        ]
    );
}

#[test]
fn a_bare_id_is_read_as_the_id_whatever_the_table_says() {
    let aliases = BTreeMap::from([(ULID.to_owned(), "01BX5ZZKBKACTAV9WEVGEMMVRZ".to_owned())]);
    let resolved = resolve_references(&paragraph(&format!("[[{ULID}]]")), &aliases);
    assert_eq!(
        inline(&resolved),
        [Phrasing::WikiLink { document_id: ULID.into(), alias: None, fragment: None }]
    );
}
