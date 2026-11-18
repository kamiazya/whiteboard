//! The SVG backend against the recorded TypeScript answers.
//!
//! `packages/canvas-render/src/oracle/svg.jsonl` holds, per scene, what
//! the TypeScript SVG backend (deleted, ADR-0054 A3.6) answered for it, whole
//! and keyed, and the envelope options it was drawn with; the file is frozen
//! and this replays it. Every record must be
//! reproduced byte for byte: the document, the keyed root and each group. The
//! scenes are the pixel and determinism goldens, the pixel goldens as the
//! browser mounts them, and the scenes the composer's recording laid out, so
//! the SVG stage is judged apart from layout.

mod common;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

#[test]
fn every_recorded_scene_is_drawn_as_the_typescript_drew_it() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/svg.jsonl");
    let replayed = common::replay(text);
    assert!(replayed.is_ok(), "{replayed:?}");
    let (count, failures) = replayed.unwrap_or_default();
    assert!(count >= 187, "the recording holds {count} records");
    assert!(failures.is_empty(), "{} records differ; first:\n{}", failures.len(), failures[0]);
}
