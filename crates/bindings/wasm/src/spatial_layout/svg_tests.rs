//! The SVG a layout answers beside its scene (`svg`): drawn from the scene the
//! same answer carries, with the envelope the request names, on both entries
//! that lay out a whole picture, and refused rather than cut short.

use serde_json::{Value as Json, json};
use whiteboard_canvas_render::scene_bounds::scene_document_bounds;
use whiteboard_canvas_render::svg::{SvgDocumentOptions, render_scene_to_svg};
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_scene::{BoundingBox, Scene, SceneNode, ThematicBreakNode};

use super::answer::svg_item;
use super::request::{SvgAsk, ViewBox};
use super::tests::{answer, board, fake, m, request, s};
use super::{MAX_SVG_BYTES, layout_with_host, query_with_host};
use crate::json_canvas_wire::canvas_json;

/// The scene an answer carries, read back as the backend reads one.
fn scene_of(answer: &Json) -> Scene {
    let scene = answer.get(1).cloned().unwrap_or(Json::Null);
    serde_json::from_value(scene).unwrap_or_default()
}

fn svg_of(answer: &Json, at: usize) -> &str {
    answer.get(at).and_then(Json::as_str).unwrap_or_default()
}

fn ask(view_box: Option<ViewBox>) -> SvgAsk {
    SvgAsk { view_box, padding: None, background: None, text_fill: None, raster_scale: None }
}

#[test]
fn an_asked_svg_is_answered_last_drawn_from_the_scene_beside_it() {
    let options = m(&[
        ("padding", json!(24)),
        ("background", json!("#fafafa")),
        ("textFill", json!("#111111")),
        ("rasterScale", json!(2)),
    ]);
    let got = answer(&request(board("hello **world**"), &[("svg", options)]));
    assert_eq!(got.get(0), Some(&json!("ok")), "{got}");
    assert_eq!(got.as_array().map(Vec::len), Some(5), "{got}");
    let scene = scene_of(&got);
    assert!(!scene.nodes.is_empty());
    let drawn = SvgDocumentOptions {
        padding: Some(24.0),
        background: Some("#fafafa".to_owned()),
        text_fill: Some("#111111".to_owned()),
        raster_scale: Some(2.0),
        ..SvgDocumentOptions::default()
    };
    let expected = render_scene_to_svg(&scene, Some(&drawn)).unwrap_or_default();
    assert!(expected.contains("fill=\"#111111\""), "{expected}");
    assert_eq!(svg_of(&got, 4), expected);
    // Without `svg` the answer is the scene alone, as before.
    let plain = answer(&request(board("hello **world**"), &[]));
    assert_eq!(plain.as_array().map(Vec::len), Some(4));
    assert_eq!(plain.get(1), got.get(1));
}

#[test]
fn a_document_view_box_is_the_scene_document_bounds_or_empty() {
    let svg = m(&[("viewBox", json!("document"))]);
    let got = answer(&request(board("hello"), &[("svg", svg.clone())]));
    let scene = scene_of(&got);
    let bounds = scene_document_bounds(&scene);
    let drawn = SvgDocumentOptions { view_box: Some(bounds), ..SvgDocumentOptions::default() };
    assert_eq!(svg_of(&got, 4), render_scene_to_svg(&scene, Some(&drawn)).unwrap_or_default());
    // A scene drawing nothing is answered an empty box, not the bounds' 1x1 fallback.
    let empty = canvas_json(&SpatialCanvas::default());
    let nothing = answer(&request(empty, &[("svg", svg)]));
    assert!(scene_of(&nothing).nodes.is_empty(), "{nothing}");
    assert_eq!(
        svg_of(&nothing, 4),
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" viewBox="0 0 0 0"></svg>"#
    );
}

#[test]
fn the_svg_follows_the_fragment_sources_a_table_asked_for() {
    let got = answer(&request(
        board("$$x^2$$"),
        &[("fragments", s(Vec::new())), ("svg", m(&[("padding", json!(0))]))],
    ));
    assert_eq!(got.get(0), Some(&json!("ok")), "{got}");
    assert!(got.get(4).is_some_and(Json::is_array), "{got}");
    assert!(svg_of(&got, 5).starts_with("<svg "), "{got}");
}

fn note(extra: &[(&str, Json)]) -> String {
    let mut fields = vec![
        ("kind", json!("markdown")),
        ("body", json!("# Title\n\nSome *prose*.")),
        ("maxWidth", json!(480)),
        ("measure", fake()),
        ("mode", json!("light")),
    ];
    fields.extend(extra.iter().cloned());
    m(&fields).to_string()
}

fn markdown_answer(request: &str) -> Json {
    serde_json::from_str(&layout_with_host(request, None)).unwrap_or(Json::Null)
}

#[test]
fn a_note_answers_its_svg_and_a_comment_may_not_ask_for_one() {
    let svg = m(&[("viewBox", json!("document"))]);
    let got = markdown_answer(&note(&[("svg", svg.clone())]));
    assert_eq!(got.get(0), Some(&json!("ok")), "{got}");
    let scene = scene_of(&got);
    let drawn = SvgDocumentOptions {
        view_box: Some(scene_document_bounds(&scene)),
        ..SvgDocumentOptions::default()
    };
    assert_eq!(svg_of(&got, 4), render_scene_to_svg(&scene, Some(&drawn)).unwrap_or_default());
    let comment = m(&[
        ("kind", json!("comment")),
        ("body", json!("hi")),
        ("maxWidth", json!(200)),
        ("measure", fake()),
        ("density", json!("compact")),
        ("svg", svg),
    ]);
    assert_eq!(markdown_answer(&comment.to_string()), json!(["refused", "malformed", "request"]));
}

#[test]
fn a_query_or_an_svg_naming_what_it_does_not_hold_is_no_request() {
    let refused = json!(["refused", "malformed", "request"]);
    for svg in [
        m(&[("viewBox", json!("scene"))]),
        m(&[("viewBox", m(&[("x", json!(0))]))]),
        m(&[("width", json!(10))]),
        m(&[("padding", json!("8"))]),
        json!("document"),
    ] {
        assert_eq!(answer(&request(board("x"), &[("svg", svg)])), refused);
    }
    let edges = m(&[
        ("query", json!("edges")),
        ("canvas", board("x")),
        ("measure", fake()),
        ("mode", json!("light")),
        ("expand", json!(false)),
        ("svg", m(&[])),
    ]);
    let queried: Json =
        serde_json::from_str(&query_with_host(&edges.to_string(), None)).unwrap_or(Json::Null);
    assert_eq!(queried, refused);
}

#[test]
fn an_svg_past_what_the_answer_carries_is_refused_whole() {
    assert_eq!(MAX_SVG_BYTES, 64 * 1024 * 1024);
    let got = answer(&request(board("hello"), &[("svg", m(&[]))]));
    let scene = scene_of(&got);
    let len = svg_of(&got, 4).len();
    assert!(len > 0);
    let drawn = svg_item(&scene, &ask(None), len);
    assert!(drawn.is_ok_and(|item| item.to_json().is_ok_and(|text| text.len() > len)));
    assert_eq!(svg_item(&scene, &ask(None), len - 1), Err(answer_text("input-too-large", "svg")));
}

fn answer_text(code: &str, class: &str) -> String {
    json!(["refused", code, class]).to_string()
}

#[test]
fn a_scene_the_document_cannot_spell_is_refused() {
    let nan = BoundingBox { x: f64::NAN, y: 0.0, w: 10.0, h: 10.0 };
    let scene = Scene {
        nodes: vec![SceneNode::ThematicBreak(ThematicBreakNode { bbox: nan, appearance: None })],
        legend: None,
    };
    let refused = Err(answer_text("malformed", "non-finite"));
    assert_eq!(svg_item(&scene, &ask(Some(ViewBox::Document)), MAX_SVG_BYTES), refused);
}

#[test]
fn the_raster_scale_budgets_the_filters_at_the_zoom_drawn() {
    let mut node = super::tests::text_node("a", "glow");
    node.width = 2400.0;
    node.height = 2400.0;
    let big = canvas_json(&SpatialCanvas { nodes: vec![node], ..SpatialCanvas::default() });
    let neon = |svg: Json| {
        let got = answer(&request(big.clone(), &[("style", json!("visual.neon")), ("svg", svg)]));
        svg_of(&got, 4).to_owned()
    };
    let at_one = neon(m(&[]));
    let at_three = neon(m(&[("rasterScale", json!(3))]));
    // The glow fits the budget at the zoom the document is drawn at, and not at three times it.
    assert!(at_one.contains("filter="), "{at_one}");
    assert!(!at_three.contains("filter="), "{at_three}");
}

#[test]
fn the_fuzz_seeds_asking_for_svg_are_answered() {
    for seed in [
        include_str!("../../../../fuzz/seeds/layout_spatial_canvas_wasm/svg"),
        include_str!("../../../../fuzz/seeds/layout_spatial_canvas_wasm/markdown-svg"),
    ] {
        let got = markdown_answer(seed);
        assert_eq!(got.get(0), Some(&json!("ok")), "{got}");
        assert!(
            got.as_array()
                .and_then(|a| a.last())
                .and_then(Json::as_str)
                .is_some_and(|svg| svg.starts_with("<svg ")),
            "{got}"
        );
    }
}
