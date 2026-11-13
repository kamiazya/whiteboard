//! What `node-box.jsonl` cannot carry: its content scenes are JSON, which holds
//! no NaN and writes `-0` as `0`. Each expected value here is what the
//! TypeScript's `placeInNode` answered for the same input.

use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::{
    NodeBoxHost, NodeBoxOptions, TextPlacement, content_width, fit_scene_in_node, place_in_node,
};
use whiteboard_canvas_render::theme::geometry::SPATIAL_THEME_GEOMETRY;
use whiteboard_canvas_render::theme::geometry::SpatialGeometry;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{BoundingBox, ParagraphBlockNode, SceneNode, ShapeSceneNode, TextRunNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A rect whose text a contribution asks to centre.
struct Centred;

/// A cylinder, whose text centres by default.
struct Cylinder;

impl NodeBoxHost for Cylinder {
    fn silhouette(&self, _node_id: &str) -> Option<&str> {
        Some("visual.cylinder")
    }

    fn text_placement(&self, _node: &SpatialNode) -> Option<TextPlacement> {
        None
    }
}

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

/// The options every example lays out with: the fake measurer, the light theme
/// and `geometry`, with the text centred.
fn with_options<T>(geometry: SpatialGeometry, lay: impl FnOnce(&NodeBoxOptions<'_>) -> T) -> T {
    with_host(geometry, &Centred, lay)
}

fn with_host<T>(
    geometry: SpatialGeometry,
    host: &dyn NodeBoxHost,
    lay: impl FnOnce(&NodeBoxOptions<'_>) -> T,
) -> T {
    let measure = FakeMeasure::default();
    let theme = create_spatial_theme(SpatialThemeMode::Light, None);
    lay(&NodeBoxOptions {
        measure: &measure,
        appearance: &theme,
        geometry,
        fit_to_box: true,
        theme: None,
        host,
    })
}

fn node(width: f64, height: f64) -> SpatialNode {
    SpatialNode { id: "n".to_owned(), width, height, ..SpatialNode::default() }
}

/// Two runs at `tops`, 20px apart, placed centred in a 200x100 node: the
/// paragraph's box and the runs' left edges.
fn placed(tops: [f64; 2]) -> Option<(BoundingBox, Vec<f64>)> {
    let paragraph = SceneNode::Paragraph(ParagraphBlockNode {
        bbox: BoundingBox { x: 0.0, y: 0.0, w: 100.0, h: 16.0 },
        runs: vec![run(0.0, tops[0]), run(20.0, tops[1])],
    });
    let placed = with_options(SPATIAL_THEME_GEOMETRY, |o| {
        place_in_node(&node(200.0, 100.0), &[paragraph], o)
    });
    match placed.first() {
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

/// A width exactly at the floor is the floor: a node `-0` wide with no padding
/// wraps at `+0`, not at its own `-0` (JSON writes `-0` as `0`).
#[test]
fn a_width_at_the_floor_is_the_floor_with_its_sign() {
    let geometry = SpatialGeometry { padding_px: 0.0, ..SPATIAL_THEME_GEOMETRY };
    let width = with_options(geometry, |o| content_width(&node(-0.0, 10.0), o));
    assert_eq!(width.to_bits(), 0.0_f64.to_bits());
}

/// A line exactly as wide as the box is not moved: only a narrower one is
/// centred, so a run at 10 stays at 10 (18 once the padding is added).
#[test]
fn a_line_as_wide_as_the_box_is_not_moved() {
    let paragraph = SceneNode::Paragraph(ParagraphBlockNode {
        bbox: BoundingBox { x: 0.0, y: 0.0, w: 184.0, h: 16.0 },
        runs: vec![TextRunNode {
            bbox: BoundingBox { x: 10.0, y: 0.0, w: 184.0, h: 16.0 },
            ..run(0.0, 0.0)
        }],
    });
    let placed = with_options(SPATIAL_THEME_GEOMETRY, |o| {
        place_in_node(&node(200.0, 100.0), &[paragraph], o)
    });
    let line = BoundingBox { x: 18.0, y: 42.0, w: 184.0, h: 16.0 };
    let Some(SceneNode::Paragraph(p)) = placed.first() else {
        panic!("a paragraph: {placed:?}");
    };
    assert_eq!((p.bbox, p.runs.first().map(|r| r.bbox)), (line, Some(line)));
}

fn shape(height: f64) -> SceneNode {
    SceneNode::Shape(Box::new(ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: None,
        bbox: BoundingBox { x: 0.0, y: 0.0, w: 10.0, h: height },
        comment_chrome: false,
        proposal_chrome: None,
        radius: None,
        shape: None,
        appearance: None,
        task_box: None,
        ink: None,
    }))
}

/// Where a 10px-wide shape `height` tall lands, as its top, in `node`.
fn shape_top(node: &SpatialNode, height: f64, padding: f64, host: &dyn NodeBoxHost) -> f64 {
    let geometry = SpatialGeometry { padding_px: padding, ..SPATIAL_THEME_GEOMETRY };
    let placed = with_host(geometry, host, |o| place_in_node(node, &[shape(height)], o));
    match placed.first() {
        Some(SceneNode::Shape(s)) => s.bbox.y,
        _ => f64::NAN,
    }
}

fn node_at(y: f64, height: f64) -> SpatialNode {
    SpatialNode { y, ..node(200.0, height) }
}

/// Content shorter than the padded box is centred by half the room left, which is
/// the general formula's answer in exact arithmetic but not in doubles: here the
/// two differ in the last bit, and the TypeScript answers the short form's.
#[test]
fn content_that_fits_centres_by_half_the_room_left() {
    let top = shape_top(&node_at(-27.8, 49.9), 7.3, 8.0, &Centred);
    assert_eq!(top.to_bits(), 0xc01a_0000_0000_0002, "{top}");
}

/// Content exactly as tall as the padded box takes the general formula, which
/// here is one ulp off zero rather than zero.
#[test]
fn content_as_tall_as_the_padded_box_takes_the_general_offset() {
    let top = shape_top(&node_at(4.64, 37.32), 30.6, 3.36, &Centred);
    assert_eq!(top.to_bits(), 0x401f_ffff_ffff_ffff, "{top}");
}

/// Content taller than a cylinder's inscribed box but inside the node is centred
/// on the inscribed box and then held inside the node: 90px in a 100px cylinder
/// would start at 15 and is pulled up to 10.
#[test]
fn content_taller_than_the_inscribed_box_is_held_inside_the_node() {
    assert_eq!(shape_top(&node(200.0, 100.0), 90.0, 8.0, &Cylinder).to_bits(), 10.0_f64.to_bits());
}

/// A padded box with no room in either direction fits nothing, even content
/// that would fit in the other: no width at all (a 16px-wide node, 8px padding),
/// or no height with content of no height.
#[test]
fn a_box_with_no_room_in_one_direction_fits_nothing() {
    let fits = |width, height, content: f64| {
        with_options(SPATIAL_THEME_GEOMETRY, |o| {
            fit_scene_in_node(&[shape(content)], &node(width, height), o).is_some()
        })
    };
    assert!(!fits(16.0, 40.0, 10.0), "no width");
    assert!(!fits(40.0, 16.0, 0.0), "no height");
    assert!(fits(16.5, 16.5, 0.0), "a little of each");
}
