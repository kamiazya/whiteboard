//! What `node-box.jsonl` cannot carry: its content scenes are JSON, which holds
//! no NaN and writes `-0` as `0`. Each expected value here is what the
//! TypeScript's `placeInNode` answered for the same input.

use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::{
    NodeBoxHost, NodeBoxOptions, TextPlacement, place_in_node,
};
use whiteboard_canvas_render::theme::geometry::SPATIAL_THEME_GEOMETRY;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{BoundingBox, ParagraphBlockNode, SceneNode, TextRunNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A rect whose text a contribution asks to centre.
struct Centred;

impl NodeBoxHost for Centred {
    fn silhouette(&self, _node_id: &str) -> Option<&str> {
        None
    }

    fn text_placement(&self, _node: &SpatialNode) -> Option<TextPlacement> {
        Some(TextPlacement::Center)
    }
}

fn run(x: f64, y: f64) -> TextRunNode {
    TextRunNode {
        bbox: BoundingBox { x, y, w: 10.0, h: 16.0 },
        text: "t".to_owned(),
        emphasis: false,
        strong: false,
        code: false,
        deleted: false,
        link: None,
        truncated: false,
        overflows: false,
        appearance: None,
        paints: None,
        backdrop: None,
        backdrop_pad_x_px: None,
        annotates: None,
        baseline: None,
    }
}

/// Two runs at `tops`, 20px apart, placed centred in a 200x100 node: the
/// paragraph's box and the runs' left edges.
fn placed(tops: [f64; 2]) -> Option<(BoundingBox, Vec<f64>)> {
    let measure = FakeMeasure::default();
    let theme = create_spatial_theme(SpatialThemeMode::Light, None);
    let options = NodeBoxOptions {
        measure: &measure,
        appearance: &theme,
        geometry: SPATIAL_THEME_GEOMETRY,
        fit_to_box: true,
        theme: None,
        host: &Centred,
    };
    let node =
        SpatialNode { id: "n".to_owned(), width: 200.0, height: 100.0, ..SpatialNode::default() };
    let paragraph = SceneNode::Paragraph(ParagraphBlockNode {
        bbox: BoundingBox { x: 0.0, y: 0.0, w: 100.0, h: 16.0 },
        runs: vec![run(0.0, tops[0]), run(20.0, tops[1])],
    });
    match place_in_node(&node, &[paragraph], &options).first() {
        Some(SceneNode::Paragraph(p)) => Some((p.bbox, p.runs.iter().map(|r| r.bbox.x).collect())),
        _ => None,
    }
}

/// Both runs on one 30px line, centred as one.
const ONE_LINE: BoundingBox = BoundingBox { x: 85.0, y: 42.0, w: 30.0, h: 16.0 };

/// A line is the runs sharing a top, keyed as a `Map` keys them: a NaN top is one
/// line, not one line per run, so the two runs centre together.
#[test]
fn runs_whose_top_is_nan_are_one_line() {
    assert_eq!(placed([f64::NAN, f64::NAN]), Some((ONE_LINE, vec![85.0, 105.0])));
}

/// A NaN top is not every top: beside a finite one it is a line of its own, and
/// each 10px line centres alone.
#[test]
fn a_nan_top_beside_a_finite_one_is_two_lines() {
    let alone = BoundingBox { x: 95.0, y: 42.0, w: 10.0, h: 16.0 };
    assert_eq!(placed([f64::NAN, 0.0]), Some((alone, vec![95.0, 95.0])));
    assert_eq!(placed([0.0, f64::NAN]), Some((alone, vec![95.0, 95.0])));
}

/// The two zeros are one `Map` key, in either order.
#[test]
fn runs_at_both_zeros_are_one_line() {
    assert_eq!(placed([-0.0, 0.0]), Some((ONE_LINE, vec![85.0, 105.0])));
    assert_eq!(placed([0.0, -0.0]), Some((ONE_LINE, vec![85.0, 105.0])));
}
