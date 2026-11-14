use serde_json::{Value as Json, json};
use whiteboard_model::spatial::{NodeResource, SpatialCanvas, SpatialNode};

use super::{MAX_BODY_BYTES, MAX_ELEMENTS, layout_spatial_canvas};
use crate::input_caps::LAYOUT_SPATIAL_CANVAS;
use crate::json_canvas_wire::canvas_json;

/// A mapping on the value wire.
fn m(fields: &[(&str, Json)]) -> Json {
    let mut out = vec![json!("m")];
    for (key, value) in fields {
        out.push(json!(key));
        out.push(value.clone());
    }
    Json::Array(out)
}

fn s(items: Vec<Json>) -> Json {
    let mut out = vec![json!("s")];
    out.extend(items);
    Json::Array(out)
}

fn text_node(id: &str, body: &str) -> SpatialNode {
    SpatialNode {
        id: id.to_owned(),
        x: 0.0,
        y: 0.0,
        width: 160.0,
        height: 80.0,
        resource: Some(NodeResource {
            mime_type: "text/markdown".to_owned(),
            content: Some(body.to_owned()),
            ..NodeResource::default()
        }),
        ..SpatialNode::default()
    }
}

fn board(body: &str) -> Json {
    canvas_json(&SpatialCanvas { nodes: vec![text_node("a", body)], ..SpatialCanvas::default() })
}

fn fake() -> Json {
    m(&[("kind", json!("fake")), ("factor", json!(["f", "3fe3333333333333"]))])
}

fn request(canvas: Json, extra: &[(&str, Json)]) -> String {
    let mut fields = vec![
        ("canvas", canvas),
        ("measure", fake()),
        ("mode", json!("light")),
        ("expand", json!(true)),
    ];
    for (key, value) in extra {
        fields.retain(|(name, _)| name != key);
        fields.push((key, value.clone()));
    }
    m(&fields).to_string()
}

fn answer(request: &str, fonts: &[u8]) -> Json {
    serde_json::from_str(&layout_spatial_canvas(request, fonts)).unwrap_or(Json::Null)
}

#[test]
fn a_canvas_is_answered_with_its_scene_anchors_and_degradations() {
    let got = answer(&request(board("hello"), &[]), &[]);
    assert_eq!(got.get(0), Some(&json!("ok")));
    let nodes = got.pointer("/1/nodes").and_then(Json::as_array).map(Vec::len);
    assert!(nodes.is_some_and(|n| n >= 2), "{got}");
    assert_eq!(got.get(2), Some(&json!([])));
    assert_eq!(got.get(3), Some(&json!([])));
    assert!(got.to_string().contains("\"hello\""), "{got}");
    let dark = answer(&request(board("hello"), &[("mode", json!("dark"))]), &[]);
    assert_ne!(dark.get(1), got.get(1));
}

#[test]
fn what_the_core_cannot_answer_as_the_typescript_would_is_declined() {
    let shortcode = answer(&request(board("a :rocket: b"), &[]), &[]);
    assert_eq!(shortcode, json!(["declined", "shortcode"]));
    let fence = answer(&request(board("```rust\nfn x() {}\n```"), &[]), &[]);
    assert_eq!(fence, json!(["declined", "highlight"]));
    let at_cap = answer(&request(board(&"a".repeat(MAX_BODY_BYTES)), &[]), &[]);
    assert_eq!(at_cap.get(0), Some(&json!("ok")));
    let huge = canvas_json(&SpatialCanvas {
        nodes: vec![SpatialNode { x: f64::INFINITY, ..text_node("a", "x") }],
        ..SpatialCanvas::default()
    });
    assert_eq!(answer(&request(huge, &[]), &[]), json!(["declined", "non-finite"]));
}

#[test]
fn an_input_that_is_not_a_request_or_past_its_caps_is_refused() {
    let refused = |code: &str, class: &str| json!(["refused", code, class]);
    let big = vec![0_u8; LAYOUT_SPATIAL_CANVAS.max_bytes];
    assert_eq!(answer("{}", &big), refused("input-too-large", "too-large"));
    assert_eq!(answer("{", &[]), refused("malformed", "wire"));
    assert_eq!(answer("{}", &[]), refused("malformed", "wire"));
    assert_eq!(answer(&m(&[]).to_string(), &[]), refused("malformed", "request"));
    let unknown = request(board("x"), &[("colour", json!("red"))]);
    assert_eq!(answer(&unknown, &[]), refused("malformed", "request"));
    let many = canvas_json(&SpatialCanvas {
        nodes: (0..=MAX_ELEMENTS).map(|i| text_node(&format!("n{i}"), "")).collect(),
        ..SpatialCanvas::default()
    });
    assert_eq!(answer(&request(many, &[]), &[]), refused("input-too-large", "too-many-elements"));
    let half = "a".repeat(MAX_BODY_BYTES / 2 + 1);
    let two = canvas_json(&SpatialCanvas {
        nodes: vec![text_node("a", &half), text_node("b", &half)],
        ..SpatialCanvas::default()
    });
    assert_eq!(answer(&request(two, &[]), &[]), refused("input-too-large", "bodies"));
    let third = "a".repeat(MAX_BODY_BYTES / 3 + 1);
    let entries = s(vec![
        s(vec![json!("n"), m(&[("body", json!(third))])]),
        s(vec![json!("c"), m(&[("canvas", board(&third))])]),
        s(vec![json!("g"), Json::Null]),
    ]);
    let references = m(&[
        ("entries", entries),
        ("aliases", s(Vec::new())),
        ("titles", s(Vec::new())),
        ("extras", s(Vec::new())),
    ]);
    let asking = request(board(&third), &[("references", references)]);
    assert_eq!(answer(&asking, &[]), refused("input-too-large", "bodies"));
    let face = |from: i64, to: i64| {
        let face = m(&[
            ("family", json!("F")),
            ("bold", json!(false)),
            ("italic", json!(false)),
            ("from", json!(from)),
            ("to", json!(to)),
        ]);
        m(&[("kind", json!("fonts")), ("faces", s(vec![face]))])
    };
    let outside = request(board("x"), &[("measure", face(0, 4))]);
    assert_eq!(answer(&outside, &[0, 1]), refused("malformed", "font"));
    let not_a_font = request(board("x"), &[("measure", face(0, 2))]);
    assert_eq!(answer(&not_a_font, &[0, 1]), refused("malformed", "font"));
}

#[test]
fn a_request_with_no_face_measures_by_the_ratio_estimate() {
    let no_face = m(&[("kind", json!("fonts")), ("faces", s(Vec::new()))]);
    let ratio = m(&[("kind", json!("ratio"))]);
    let by_fonts = answer(&request(board("hello"), &[("measure", no_face)]), &[]);
    let by_ratio = answer(&request(board("hello"), &[("measure", ratio)]), &[]);
    let by_fake = answer(&request(board("hello"), &[]), &[]);
    assert_eq!(by_fonts.get(0), Some(&json!("ok")));
    assert_eq!(by_fonts, by_ratio);
    assert_ne!(by_ratio, by_fake);
}

const ROBOTO: &[u8] =
    include_bytes!("../../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-Regular.ttf");

fn roboto() -> Json {
    let face = m(&[
        ("family", json!("Roboto")),
        ("bold", json!(false)),
        ("italic", json!(false)),
        ("from", json!(0)),
        ("to", json!(ROBOTO.len())),
    ]);
    m(&[("kind", json!("fonts")), ("faces", s(vec![face]))])
}

#[test]
fn a_font_measures_what_it_holds_and_declines_a_mark_it_would_combine() {
    let by_font = answer(&request(board("hello"), &[("measure", roboto())]), ROBOTO);
    let by_ratio =
        answer(&request(board("hello"), &[("measure", m(&[("kind", json!("ratio"))]))]), &[]);
    assert_eq!(by_font.get(0), Some(&json!("ok")));
    assert_ne!(by_font, by_ratio);
    let marked = request(board("cafe\u{301} \u{200d}"), &[("measure", roboto())]);
    assert_eq!(answer(&marked, ROBOTO), json!(["declined", "measure"]));
    let estimated = request(board("cafe\u{301}"), &[("measure", m(&[("kind", json!("ratio"))]))]);
    assert_eq!(answer(&estimated, &[]).get(0), Some(&json!("ok")));
}

fn two_boxes() -> Json {
    let edge = whiteboard_model::spatial::CanvasEdge {
        id: "e".to_owned(),
        from: whiteboard_model::spatial::EdgeEnd { node: "a".to_owned(), ..Default::default() },
        to: whiteboard_model::spatial::EdgeEnd { node: "b".to_owned(), ..Default::default() },
        ..Default::default()
    };
    let b = SpatialNode { x: 400.0, y: 300.0, ..text_node("b", "b") };
    canvas_json(&SpatialCanvas {
        nodes: vec![text_node("a", "a"), b],
        edges: vec![edge],
        ..SpatialCanvas::default()
    })
}

#[test]
fn every_side_and_a_pinned_point_are_read_from_an_override() {
    let pinned = |from: &str, to: &str| {
        let pin = m(&[
            ("fromSide", json!(from)),
            ("toSide", json!(to)),
            ("from", m(&[("x", json!(160)), ("y", json!(40))])),
        ]);
        let request = request(two_boxes(), &[("sideOverrides", s(vec![s(vec![json!("e"), pin])]))]);
        answer(&request, &[])
    };
    let answers = [
        pinned("left", "right"),
        pinned("right", "left"),
        pinned("top", "bottom"),
        pinned("bottom", "top"),
    ];
    for (at, answer) in answers.iter().enumerate() {
        assert_eq!(answer.get(0), Some(&json!("ok")), "{at}: {answer}");
        assert!(answers.iter().skip(at + 1).all(|other| other.get(2) != answer.get(2)), "{at}");
    }
}

#[test]
fn a_request_at_each_cap_is_read() {
    let text = request(board("x"), &[]);
    let fill = vec![0_u8; LAYOUT_SPATIAL_CANVAS.max_bytes - text.len()];
    assert_eq!(answer(&text, &fill).get(0), Some(&json!("ok")));
    let at_cap = canvas_json(&SpatialCanvas {
        nodes: (0..MAX_ELEMENTS).map(|i| text_node(&format!("n{i}"), "")).collect(),
        ..SpatialCanvas::default()
    });
    assert_eq!(answer(&request(at_cap, &[]), &[]).get(0), Some(&json!("ok")));
}
