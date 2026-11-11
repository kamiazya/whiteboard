//! The SVG backend against the second recording of the TypeScript's answers.
//!
//! `svg-edge-cases.jsonl` holds small scenes aimed at one rule each: what a
//! document does with an unusable option, how a link is addressed, which
//! attribute a degenerate box drops, how the filter budget thins an
//! over-budget board. The goldens in `svg.jsonl` reach those only by accident,
//! so this is where a port that draws every golden can still be wrong.

mod common;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[test]
fn every_edge_case_is_drawn_as_the_typescript_drew_it() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/svg-edge-cases.jsonl");
    let replayed = common::replay(text);
    assert!(replayed.is_ok(), "{replayed:?}");
    let (count, failures) = replayed.unwrap_or_default();
    assert!(count >= 67, "the recording holds {count} records");
    assert!(failures.is_empty(), "{} records differ; first:\n{}", failures.len(), failures[0]);
}
