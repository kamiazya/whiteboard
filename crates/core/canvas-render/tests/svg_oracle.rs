//! The SVG backend against the recorded TypeScript answers.
//!
//! `packages/canvas-render/src/oracle/svg.jsonl` holds, per scene, what
//! `renderSceneToSvg` and `renderSceneToKeyedSvg` answered for it and the
//! envelope options it was drawn with; its test fails when the file no longer
//! equals the TypeScript's answer, and this replays it. Every record must be
//! reproduced byte for byte: the document, the keyed root and each group. The
//! scenes are the pixel and determinism goldens and the scenes the composer's
//! recording lays out, so the SVG stage is judged apart from layout.

mod common;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[test]
fn every_recorded_scene_is_drawn_as_the_typescript_drew_it() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/svg.jsonl");
    let replayed = common::replay(text);
    assert!(replayed.is_ok(), "{replayed:?}");
    let (count, failures) = replayed.unwrap_or_default();
    assert!(count >= 179, "the recording holds {count} records");
    assert!(failures.is_empty(), "{} records differ; first:\n{}", failures.len(), failures[0]);
}
