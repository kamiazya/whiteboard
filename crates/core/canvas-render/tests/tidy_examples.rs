//! `tidy_nodes` on the boards whose answer is a decision rather than a replay of
//! the recording (`tidy_oracle.rs`): the cases where the core is held to a rule
//! the TypeScript did not keep.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::tidy::{TidyNode, TidyOptions, tidy_nodes};

fn node(id: &str, x: f64, y: f64, w: f64, h: f64) -> TidyNode {
    TidyNode { id: id.to_string(), frame: false, x, y, width: w, height: h }
}

fn frame(id: &str, x: f64, y: f64, w: f64, h: f64) -> TidyNode {
    TidyNode { frame: true, ..node(id, x, y, w, h) }
}

/// A chain of frames, each more than half inside the next and only the next.
fn frame_chain(n: usize) -> Vec<TidyNode> {
    (0..n)
        .map(|i| {
            let i = f64::from(u32::try_from(i).unwrap_or(0));
            frame(&format!("f{i}"), i * 400.0, 0.0, 1000.0 + i, 1000.0 + i)
        })
        .collect()
}

#[test]
fn the_deepest_chain_of_frames_the_canvas_holds_still_tidies() {
    let nodes = frame_chain(2000);
    // Unbudgeted this walk is quartic in the frames: minutes, not a failure,
    // so completing is what the test can assert (the core reads no clock).
    let moves = tidy_nodes(&nodes, &TidyOptions::default());
    assert!(!moves.is_empty());
}
