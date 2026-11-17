//! `tidy_nodes` on the boards whose answer is a decision rather than a replay of
//! the recording (`tidy_oracle.rs`): the cases where the core is held to a rule
//! the TypeScript did not keep.

use std::collections::BTreeMap;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::tidy::{TidyNode, TidyOptions, tidy_nodes};

fn node(id: &str, x: f64, y: f64, w: f64, h: f64) -> TidyNode {
    TidyNode { id: id.to_string(), frame: false, x, y, width: w, height: h }
}

fn frame(id: &str, x: f64, y: f64, w: f64, h: f64) -> TidyNode {
    TidyNode { frame: true, ..node(id, x, y, w, h) }
}

fn edge(a: &str, b: &str) -> (Option<String>, Option<String>) {
    (Some(a.to_string()), Some(b.to_string()))
}

/// Where each node ends up: its answered move, else where it was given.
fn settled(nodes: &[TidyNode], options: &TidyOptions) -> BTreeMap<String, (f64, f64)> {
    let moves = tidy_nodes(nodes, options);
    nodes
        .iter()
        .map(|n| {
            let at = moves.iter().find(|m| m.id == n.id).map_or((n.x, n.y), |m| (m.x, m.y));
            (n.id.clone(), at)
        })
        .collect()
}

#[test]
fn a_box_with_one_distinct_partner_is_not_a_hub_however_many_edges_join_them() {
    let nodes = [
        node("a", 0.0, 0.0, 100.0, 60.0),
        node("b", 200.0, 0.0, 100.0, 60.0),
        node("c", 400.0, 0.0, 100.0, 60.0),
    ];
    let options = TidyOptions {
        edges: Some(vec![edge("a", "b"), edge("a", "b"), edge("a", "c")]),
        ..TidyOptions::default()
    };
    let at = settled(&nodes, &options);
    // `a` is the hub, drawn at the end of its row: it trades with `b`, and `b`
    // (whose only partner is `a`) leaves it there.
    assert_eq!(at["a"], (200.0, 0.0));
    assert_eq!(at["b"], (0.0, 0.0));
    assert_eq!(at["c"], (400.0, 0.0));
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

#[test]
fn a_locked_box_off_the_whole_pixel_is_never_answered_as_moved() {
    let nodes = [node("locked", 3.4, 5.5, 100.2, 60.0), node("free", 400.0, 0.0, 100.0, 60.0)];
    let options = TidyOptions {
        locked: ["locked".to_string()].into_iter().collect(),
        ..TidyOptions::default()
    };
    let moves = tidy_nodes(&nodes, &options);
    assert!(moves.iter().all(|m| m.id != "locked"), "{moves:?}");
}
