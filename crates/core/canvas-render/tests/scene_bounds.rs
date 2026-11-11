//! The extent of a scene against the TypeScript's `sceneBounds` and
//! `sceneDocumentBounds`, case for case. A scene is written as the JSON the
//! TypeScript built it from.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::scene_bounds::{scene_bounds, scene_document_bounds};
use whiteboard_det::format::js_number_to_string;
use whiteboard_scene::{BoundingBox, Scene, SceneNode};

fn scene(json: &str) -> Scene {
    let read = serde_json::from_str(json);
    assert!(read.is_ok(), "{read:?}: {json}");
    read.unwrap_or_default()
}

/// A box as `x y w h`, each as JavaScript prints it.
fn arr(b: BoundingBox) -> String {
    [b.x, b.y, b.w, b.h].map(js_number_to_string).join(" ")
}

fn shape(x: &str, y: &str, w: &str, h: &str, rest: &str) -> String {
    format!(r#"{{"kind":"shape","bbox":{{"x":{x},"y":{y},"w":{w},"h":{h}}}{rest}}}"#)
}

fn nodes(list: &[String]) -> Scene {
    scene(&format!(r#"{{"nodes":[{}]}}"#, list.join(",")))
}

#[test]
fn an_empty_scene_is_the_unit_box_at_the_origin() {
    assert_eq!(arr(scene_bounds(&nodes(&[]))), "0 0 1 1");
}

#[test]
fn a_negative_width_is_normalised_to_its_min_and_max_edges() {
    let one = nodes(&[shape("10", "20", "-30", "5", "")]);
    assert_eq!(arr(scene_bounds(&one)), "-20 20 30 5");
}

#[test]
fn a_collapsed_axis_is_widened_to_the_minimum_extent() {
    let one = nodes(&[shape("10", "20", "0", "0", "")]);
    assert_eq!(arr(scene_bounds(&one)), "10 20 1 1");
}

#[test]
fn a_list_items_box_shifts_the_content_it_holds_by_its_own_x() {
    let list = r#"{"kind":"list","bbox":{"x":0,"y":0,"w":50,"h":50},"ordered":false,"depth":0,
        "items":[{"kind":"listItem","bbox":{"x":10,"y":0,"w":40,"h":20},"children":[
        {"kind":"glyph","bbox":{"x":5,"y":5,"w":10,"h":10},"glyph":"g"}]}]}"#;
    assert_eq!(arr(scene_bounds(&nodes(&[list.to_string()]))), "0 0 50 50");
    // A glyph at x=5 inside an item at x=10 draws at 15..25 and past a 12-wide parent.
    let narrow = r#"{"kind":"list","bbox":{"x":0,"y":0,"w":5,"h":5},"ordered":false,"depth":0,
        "items":[{"kind":"listItem","bbox":{"x":10,"y":0,"w":2,"h":2},"children":[
        {"kind":"glyph","bbox":{"x":5,"y":0,"w":10,"h":3},"glyph":"g"}]}]}"#;
    assert_eq!(arr(scene_bounds(&nodes(&[narrow.to_string()]))), "0 0 25 5");
    let cell = r#"{"kind":"table","bbox":{"x":0,"y":0,"w":5,"h":5},"rows":[{"kind":"tableRow",
        "bbox":{"x":0,"y":0,"w":5,"h":5},"cells":[{"kind":"tableCell","bbox":{"x":7,"y":0,"w":2,"h":2},
        "runs":[{"kind":"textRun","bbox":{"x":3,"y":0,"w":10,"h":2},"text":"t"}]}]}]}"#;
    assert_eq!(arr(scene_bounds(&nodes(&[cell.to_string()]))), "0 0 20 5");
}

#[test]
fn ink_glow_and_a_halo_each_widen_the_extent_by_their_own_reach() {
    let inked = shape("0", "0", "10", "10", r#","ink":{"style":"sketch","seed":1}"#);
    let glowing = r#"{"kind":"icon","icon":"star","bbox":{"x":100,"y":0,"w":10,"h":10},
        "appearance":{"glow":{"radiusPx":4}}}"#;
    let haloed = r##"{"kind":"textRun","text":"x","bbox":{"x":0,"y":200,"w":10,"h":10},
        "appearance":{"halo":"#fff"}}"##;
    let all = nodes(&[inked, glowing.to_string(), haloed.to_string()]);
    assert_eq!(arr(scene_bounds(&all)), "-8 -8 124 220");
    let empty_halo = r#"{"kind":"textRun","text":"x","bbox":{"x":0,"y":0,"w":10,"h":10},
        "appearance":{"halo":""}}"#;
    assert_eq!(arr(scene_bounds(&nodes(&[empty_halo.to_string()]))), "0 0 10 10");
}

#[test]
fn non_finite_geometry_contributes_nothing() {
    let edge = r#"{"kind":"edge","id":"e","path":[{"x":0,"y":0},{"x":5,"y":3},{"x":50,"y":10}],
        "fromSide":"left","toSide":"right","fromEnd":"none","toEnd":"arrow"}"#;
    let mut broken = nodes(&[edge.to_string()]);
    if let Some(SceneNode::Edge(e)) = broken.nodes.first_mut()
        && let Some(point) = e.path.get_mut(1)
    {
        point.x = f64::INFINITY;
    }
    // The point at infinity and the head that would point from it are skipped;
    // the two finite points still bound the line.
    assert_eq!(arr(scene_bounds(&broken)), "0 0 50 10");
    let off_box = shape("0", "0", "10", "10", "");
    let mut shapes = nodes(&[off_box, shape("0", "0", "1", "1", "")]);
    if let Some(SceneNode::Shape(s)) = shapes.nodes.get_mut(1) {
        s.bbox.x = f64::NAN;
    }
    assert_eq!(arr(scene_bounds(&shapes)), "0 0 10 10");
}

#[test]
fn an_arrowhead_reaches_past_the_line_it_ends() {
    let wings = r#"{"kind":"edge","id":"e","path":[{"x":0,"y":0},{"x":50,"y":0}],
        "fromSide":"left","toSide":"right","fromEnd":"none","toEnd":"arrow"}"#;
    assert_eq!(arr(scene_bounds(&nodes(&[wings.to_string()]))), "0 -4 50 8");
}

fn with_legend(width: &str, keys: &str, uncarried: &str) -> Scene {
    scene(&format!(
        r#"{{"nodes":[{}],"legend":{{"keys":{keys},"uncarried":{uncarried}}}}}"#,
        shape("0", "0", width, "10", "")
    ))
}

#[test]
fn a_legend_makes_room_under_the_content_and_never_beside_it() {
    let entry = r#"[{"key":"k","of":"boxes","entries":[{"value":"abc","count":1,"swatch":{}}]}]"#;
    let narrow = with_legend("10", entry, r#"{"boxes":false,"edges":true}"#);
    assert_eq!(arr(scene_document_bounds(&narrow)), "0 0 272 104");
    // The scene's own bounds are untouched by the legend.
    assert_eq!(arr(scene_bounds(&narrow)), "0 0 10 10");
    let wide = with_legend(
        "1000",
        r#"[{"key":"k","of":"boxes","entries":[]}]"#,
        r#"{"boxes":false,"edges":false}"#,
    );
    assert_eq!(arr(scene_document_bounds(&wide)), "0 0 1000 68");
}

#[test]
fn a_legend_with_nothing_to_say_changes_nothing() {
    let none = with_legend("10", "[]", r#"{"boxes":true,"edges":true}"#);
    assert_eq!(arr(scene_document_bounds(&none)), "0 0 10 10");
    assert_eq!(arr(scene_document_bounds(&nodes(&[shape("0", "0", "10", "10", "")]))), "0 0 10 10");
}

fn run(x: i32, y: i32, extra: &str) -> String {
    format!(r#"{{"kind":"textRun","text":"t","bbox":{{"x":{x},"y":{y},"w":10,"h":10}}{extra}}}"#)
}

fn edge_json(path: &[(i32, i32)], to_end: &str, extra: &str) -> String {
    let points: Vec<String> = path.iter().map(|(x, y)| format!(r#"{{"x":{x},"y":{y}}}"#)).collect();
    format!(
        r#"{{"kind":"edge","id":"e","path":[{}],"fromSide":"left","toSide":"right","fromEnd":"none","toEnd":"{to_end}"{extra}}}"#,
        points.join(",")
    )
}

fn item(x: i32, children: &str) -> String {
    format!(r#"{{"kind":"listItem","bbox":{{"x":{x},"y":0,"w":5,"h":5}},"children":[{children}]}}"#)
}

fn list(items: &str) -> String {
    format!(
        r#"{{"kind":"list","bbox":{{"x":0,"y":0,"w":5,"h":5}},"ordered":false,"depth":0,"items":[{items}]}}"#
    )
}

const HALO: &str = r##","appearance":{"halo":"#fff"}"##;
const GLOW: &str = r#","appearance":{"glow":{"radiusPx":4}}"#;
const ONE: &str = r#""bbox":{"x":0,"y":0,"w":1,"h":1}"#;

type BoundsCase = (&'static str, String, &'static str);

fn wrapper_cases() -> Vec<BoundsCase> {
    vec![
        (
            "heading_runs",
            format!(r#"{{"kind":"heading",{ONE},"level":1,"runs":[{}]}}"#, run(50, 60, "")),
            "0 0 60 70",
        ),
        (
            "paragraph_runs_halo",
            format!(r#"{{"kind":"paragraph",{ONE},"runs":[{}]}}"#, run(70, 80, HALO)),
            "0 0 82 92",
        ),
        (
            "code_runs",
            format!(r#"{{"kind":"codeBlock",{ONE},"value":"v","runs":[{}]}}"#, run(30, 40, "")),
            "0 0 40 50",
        ),
        (
            "code_glow",
            format!(
                r#"{{"kind":"codeBlock","bbox":{{"x":100,"y":100,"w":10,"h":10}},"value":"v"{GLOW}}}"#
            ),
            "94 94 22 22",
        ),
        (
            "quote_glow",
            r#"{"kind":"blockquote","bbox":{"x":100,"y":100,"w":10,"h":10},"children":[],"appearance":{"glow":{"radiusPx":6}}}"#.to_string(),
            "91 91 28 28",
        ),
        (
            "quote_kids",
            format!(r#"{{"kind":"blockquote",{ONE},"children":[{}]}}"#, run(20, 30, "")),
            "0 0 30 40",
        ),
        (
            "group_kids",
            format!(r#"{{"kind":"group",{ONE},"children":[{}]}}"#, run(25, 35, "")),
            "0 0 35 45",
        ),
        (
            "embed_kids",
            format!(
                r#"{{"kind":"embedResolved",{ONE},"documentId":"d","children":[{}]}}"#,
                run(45, 55, "")
            ),
            "0 0 55 65",
        ),
    ]
}

fn decoration_cases() -> Vec<BoundsCase> {
    vec![
        (
            "break_glow",
            format!(r#"{{"kind":"thematicBreak","bbox":{{"x":100,"y":100,"w":10,"h":1}}{GLOW}}}"#),
            "94 94 22 13",
        ),
        ("run_glow", run(100, 100, GLOW), "94 94 22 22"),
        ("run_halo", run(100, 100, HALO), "98 98 14 14"),
        ("edge_glow", edge_json(&[(0, 0), (100, 0)], "arrow", GLOW), "-6 -6 112 12"),
        (
            "edge_ink",
            edge_json(&[(0, 0), (100, 0)], "arrow", r#","ink":{"style":"sketch","seed":1}"#),
            "-8 -8 116 16",
        ),
        (
            "edge_in_item",
            list(&item(30, &edge_json(&[(0, 0), (100, 0)], "arrow", ""))),
            "0 -4 130 9",
        ),
        (
            "edge_in_nested_items",
            list(&item(30, &list(&item(7, &edge_json(&[(2, 3), (40, 9)], "arrow", ""))))),
            "0 0 77 11.391426126586168",
        ),
        ("edge_no_arrow", edge_json(&[(10, 10), (60, 40)], "none", ""), "10 10 50 30"),
        (
            "edge_ink_no_arrow",
            edge_json(&[(10, 10), (60, 40)], "none", r#","ink":{"style":"sketch","seed":1}"#),
            "2 2 66 46",
        ),
    ]
}

/// What each node kind contributes to the extent through what it holds and what
/// decorates it, case for case from the TypeScript: runs inside a block, the
/// reach of a glow, a halo, an ink, an edge inside the x-shifted subtrees of a
/// list.
#[test]
fn every_wrapper_contributes_what_it_holds_and_every_decoration_its_reach() {
    for (name, node, expected) in wrapper_cases().into_iter().chain(decoration_cases()) {
        assert_eq!(arr(scene_bounds(&nodes(&[node]))), expected, "{name}");
    }
}

#[test]
fn a_table_cell_shifts_its_runs_by_its_own_x_and_a_list_item_with_no_x_does_not() {
    let cell = format!(
        r#"{{"kind":"table",{ONE},"rows":[{{"kind":"tableRow",{ONE},"cells":[{{"kind":"tableCell","bbox":{{"x":20,"y":0,"w":5,"h":5}},"runs":[{}],"appearance":{{"glow":{{"radiusPx":2}}}}}}]}}]}}"#,
        run(3, 0, HALO)
    );
    assert_eq!(arr(scene_bounds(&nodes(&[cell]))), "0 -3 35 15");
    let mut shifted = nodes(&[list(&item(0, &run(3, 0, "")))]);
    if let Some(SceneNode::List(l)) = shifted.nodes.first_mut()
        && let Some(i) = l.items.first_mut()
    {
        i.bbox.x = f64::NAN;
    }
    assert_eq!(arr(scene_bounds(&shifted)), "0 0 13 10");
}

#[test]
fn an_edge_point_with_one_finite_coordinate_is_skipped_whole() {
    let mut e = nodes(&[edge_json(&[(0, 0), (50, 10), (60, 5)], "arrow", "")]);
    if let Some(SceneNode::Edge(edge)) = e.nodes.first_mut()
        && let Some(p) = edge.path.get_mut(1)
    {
        p.y = f64::NAN;
    }
    // The skipped point's finite x does not widen the box either; the head still does.
    assert_eq!(arr(scene_bounds(&e)), "0 0 60 5");
}

#[test]
fn a_head_whose_tip_has_one_coordinate_that_is_not_finite_is_skipped_whole() {
    let mut e = nodes(&[edge_json(&[(0, 0), (50, 10), (60, 5)], "arrow", "")]);
    if let Some(SceneNode::Edge(edge)) = e.nodes.first_mut()
        && let Some(p) = edge.path.get_mut(2)
    {
        p.y = f64::NAN;
    }
    assert_eq!(arr(scene_bounds(&e)), "0 0 50 10");
}
