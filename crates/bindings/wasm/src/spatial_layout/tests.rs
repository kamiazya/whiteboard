use serde_json::{Value as Json, json};
use whiteboard_model::spatial::{NodeResource, SpatialCanvas, SpatialNode};

use super::{MAX_BODY_BYTES, MAX_COMMENT_ITEMS, MAX_ELEMENTS, MAX_PASSAGES, layout_spatial_canvas};
use crate::input_caps::LAYOUT_SPATIAL_CANVAS;
use crate::json_canvas_wire::canvas_json;

/// A mapping on the value wire.
pub(super) fn m(fields: &[(&str, Json)]) -> Json {
    let mut out = vec![json!("m")];
    for (key, value) in fields {
        out.push(json!(key));
        out.push(value.clone());
    }
    Json::Array(out)
}

pub(super) fn s(items: Vec<Json>) -> Json {
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

pub(super) fn board(body: &str) -> Json {
    canvas_json(&SpatialCanvas { nodes: vec![text_node("a", body)], ..SpatialCanvas::default() })
}

fn fake() -> Json {
    m(&[("kind", json!("fake")), ("factor", json!(["f", "3fe3333333333333"]))])
}

pub(super) fn request(canvas: Json, extra: &[(&str, Json)]) -> String {
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

pub(super) fn answer(request: &str) -> Json {
    serde_json::from_str(&layout_spatial_canvas(request, None)).unwrap_or(Json::Null)
}

#[test]
fn a_canvas_is_answered_with_its_scene_anchors_and_degradations() {
    let got = answer(&request(board("hello"), &[]));
    assert_eq!(got.get(0), Some(&json!("ok")));
    let nodes = got.pointer("/1/nodes").and_then(Json::as_array).map(Vec::len);
    assert!(nodes.is_some_and(|n| n >= 2), "{got}");
    assert_eq!(got.get(2), Some(&json!([])));
    assert_eq!(got.get(3), Some(&json!([])));
    assert!(got.to_string().contains("\"hello\""), "{got}");
    let dark = answer(&request(board("hello"), &[("mode", json!("dark"))]));
    assert_ne!(dark.get(1), got.get(1));
}

#[test]
fn a_shortcode_is_answered_from_the_plugin_tables() {
    let shortcode = answer(&request(board("a :rocket: b :icon-star:"), &[]));
    assert_eq!(shortcode.get(0), Some(&json!("ok")), "{shortcode}");
    let scene = shortcode.to_string();
    assert!(scene.contains('🚀') && scene.contains("\"icon\""), "{shortcode}");
}

#[test]
fn what_the_core_cannot_answer_as_the_typescript_would_is_declined() {
    let at_cap = answer(&request(board(&"a".repeat(MAX_BODY_BYTES)), &[]));
    assert_eq!(at_cap.get(0), Some(&json!("ok")));
    let huge = canvas_json(&SpatialCanvas {
        nodes: vec![SpatialNode { x: f64::INFINITY, ..text_node("a", "x") }],
        ..SpatialCanvas::default()
    });
    assert_eq!(answer(&request(huge, &[])), json!(["declined", "non-finite"]));
}

#[test]
fn an_input_that_is_not_a_request_or_past_its_caps_is_refused() {
    let refused = |code: &str, class: &str| json!(["refused", code, class]);
    let big = format!("{{}}{}", " ".repeat(LAYOUT_SPATIAL_CANVAS.max_bytes - 1));
    assert_eq!(answer(&big), refused("input-too-large", "too-large"));
    assert_eq!(answer("{"), refused("malformed", "wire"));
    assert_eq!(answer("{}"), refused("malformed", "wire"));
    assert_eq!(answer(&m(&[]).to_string()), refused("malformed", "request"));
    let unknown = request(board("x"), &[("colour", json!("red"))]);
    assert_eq!(answer(&unknown), refused("malformed", "request"));
    let many = canvas_json(&SpatialCanvas {
        nodes: (0..=MAX_ELEMENTS).map(|i| text_node(&format!("n{i}"), "")).collect(),
        ..SpatialCanvas::default()
    });
    assert_eq!(answer(&request(many, &[])), refused("input-too-large", "too-many-elements"));
    let half = "a".repeat(MAX_BODY_BYTES / 2 + 1);
    let two = canvas_json(&SpatialCanvas {
        nodes: vec![text_node("a", &half), text_node("b", &half)],
        ..SpatialCanvas::default()
    });
    assert_eq!(answer(&request(two, &[])), refused("input-too-large", "bodies"));
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
    assert_eq!(answer(&asking), refused("input-too-large", "bodies"));
}

pub(super) const ROBOTO: &[u8] =
    include_bytes!("../../../../../packages/mcp-server/assets/fonts/Roboto/Roboto-Regular.ttf");

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
        answer(&request)
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
    let fill = " ".repeat(LAYOUT_SPATIAL_CANVAS.max_bytes - text.len());
    assert_eq!(answer(&format!("{text}{fill}")).get(0), Some(&json!("ok")));
    let at_cap = canvas_json(&SpatialCanvas {
        nodes: (0..MAX_ELEMENTS).map(|i| text_node(&format!("n{i}"), "")).collect(),
        ..SpatialCanvas::default()
    });
    assert_eq!(answer(&request(at_cap, &[])).get(0), Some(&json!("ok")));
}

/// A token's text and its role, if any.
type Token<'a> = (&'a str, Option<&'a str>);

/// The value wire of `[lang, value, lines]`, each line a list of `{text, role?}`.
fn fence(lang: &str, value: &str, lines: Option<&[&[Token<'_>]]>) -> Json {
    let token = |(text, role): &Token<'_>| {
        let mut fields = vec![("text", json!(text))];
        fields.extend(role.map(|r| ("role", json!(r))));
        m(&fields)
    };
    let lines = lines.map_or(Json::Null, |lines| {
        s(lines.iter().map(|line| s(line.iter().map(token).collect())).collect())
    });
    s(vec![json!(lang), json!(value), lines])
}

const JS: &str = "```js\nlet x = 1\n```\n\n```JS\nlet x = 1\n```";

#[test]
fn a_fence_the_highlighter_colours_is_asked_for_until_its_tokens_are_sent() {
    let needs = answer(&request(board(JS), &[]));
    let asked = json!(["needs", {"code": [["js", "let x = 1"], ["JS", "let x = 1"]]}]);
    assert_eq!(needs, asked);
    let words: &[Token<'_>] = &[("let", Some("keyword")), (" x = ", None), ("1", Some("number"))];
    let sent = s(vec![fence("js", "let x = 1", Some(&[words])), fence("JS", "let x = 1", None)]);
    let runs = |body: &str, sent: &Json| -> Vec<String> {
        let got = answer(&request(board(body), &[("codeTokens", sent.clone())]));
        let runs = got.pointer("/1/nodes/1/runs").and_then(Json::as_array).cloned();
        let text = |r: &Json| r.get("text").map(ToString::to_string).unwrap_or_default();
        runs.unwrap_or_default().iter().map(text).collect()
    };
    assert_eq!(runs("```js\nlet x = 1\n```", &sent), ["\"let\"", "\" x = \"", "\"1\""]);
    assert_eq!(runs("```JS\nlet x = 1\n```", &sent), ["\"let x = 1\""]);
    let both = answer(&request(board(JS), &[("codeTokens", sent)]));
    assert_eq!(both.get(0), Some(&json!("ok")), "{both}");
    for role in ["string", "comment"] {
        let one = s(vec![fence("js", "let x = 1", Some(&[&[("let x = 1", Some(role))]]))]);
        let fill = |sent: &Json| {
            let got =
                answer(&request(board("```js\nlet x = 1\n```"), &[("codeTokens", sent.clone())]));
            got.pointer("/1/nodes/1/runs/0/appearance/fill").cloned()
        };
        let keyword = s(vec![fence("js", "let x = 1", Some(&[&[("let x = 1", Some("keyword"))]]))]);
        assert_ne!(fill(&one), fill(&keyword), "{role}");
    }
}

#[test]
fn a_fence_the_highlighter_leaves_plain_is_drawn_without_asking() {
    let plain = answer(&request(board("```rust\nfn x() {}\n```"), &[]));
    assert_eq!(plain.get(0), Some(&json!("ok")), "{plain}");
}

#[test]
fn a_code_tokens_table_that_is_not_one_is_no_request() {
    let refused = json!(["refused", "malformed", "request"]);
    for bad in [
        json!("x"),
        s(vec![s(vec![json!("js"), json!("v")])]),
        s(vec![s(vec![json!("js"), json!(1), Json::Null])]),
        s(vec![fence("js", "v", Some(&[&[("t", Some("bold"))]]))]),
        s(vec![s(vec![
            json!("js"),
            json!("v"),
            s(vec![s(vec![m(&[("text", json!("t")), ("x", json!(1))])])]),
        ])]),
    ] {
        assert_eq!(answer(&request(board(JS), &[("codeTokens", bad)])), refused);
    }
}

#[test]
fn an_expansion_id_list_is_held_to_the_element_cap() {
    let listing = |n: usize| {
        let ids: Vec<Json> = (0..n).map(|i| json!(format!("f{i}"))).collect();
        answer(&request(board("x"), &[("expand", s(ids))]))
    };
    assert_eq!(listing(MAX_ELEMENTS).get(0), Some(&json!("ok")));
    assert_eq!(
        listing(MAX_ELEMENTS + 1),
        json!(["refused", "input-too-large", "too-many-elements"])
    );
}

fn file_node(id: &str, x: f64) -> SpatialNode {
    SpatialNode {
        id: id.to_owned(),
        x,
        y: 0.0,
        width: 240.0,
        height: 160.0,
        resource: Some(NodeResource {
            mime_type: "application/octet-stream".to_owned(),
            location: Some("c".to_owned()),
            ..NodeResource::default()
        }),
        ..SpatialNode::default()
    }
}

#[test]
fn a_file_node_opens_when_the_request_names_it() {
    let canvas = canvas_json(&SpatialCanvas {
        nodes: vec![file_node("f1", 0.0), file_node("f2", 300.0)],
        ..SpatialCanvas::default()
    });
    let entries = s(vec![s(vec![json!("c"), m(&[("canvas", board("inside"))])])]);
    let references = m(&[
        ("entries", entries),
        ("aliases", s(Vec::new())),
        ("titles", s(Vec::new())),
        ("extras", s(Vec::new())),
    ]);
    let opened = |expand: Json| {
        let got = answer(&request(
            canvas.clone(),
            &[("references", references.clone()), ("expand", expand)],
        ));
        assert_eq!(got.get(0), Some(&json!("ok")), "{got}");
        got.to_string().matches("\"inside\"").count()
    };
    assert_eq!(opened(json!(false)), 0);
    assert_eq!(opened(json!(true)), 2);
    assert_eq!(opened(s(vec![json!("f2")])), 1);
    assert_eq!(opened(s(vec![json!("f1"), json!("f2")])), 2);
    assert_eq!(opened(s(Vec::new())), 0);
    for not_ids in [s(vec![json!(1)]), json!("f1"), Json::Null] {
        let asking = request(canvas.clone(), &[("expand", not_ids)]);
        assert_eq!(answer(&asking), json!(["refused", "malformed", "request"]));
    }
}

#[test]
fn a_style_draws_the_theme_it_names_in_a_family_the_surface_holds() {
    let drawn = |extra: &[(&str, Json)]| answer(&request(board("hello"), extra));
    let clean = drawn(&[]);
    assert_eq!(drawn(&[("style", json!("clean"))]), clean);
    // The board names no theme, so the document's own look is the clean one.
    assert_eq!(drawn(&[("style", json!("document"))]), clean);
    let gone = drawn(&[("style", json!("visual.gone"))]);
    assert_eq!(gone.get(3), Some(&json!([{ "kind": "unknown-theme", "theme": "visual.gone" }])));
    assert_eq!(gone.get(1), clean.get(1));
    let sketch = drawn(&[("style", json!("visual.sketch"))]);
    assert_eq!(sketch.get(3), Some(&json!([{ "kind": "font-missing", "family": "Yomogi" }])));
    assert_ne!(sketch.get(1), clean.get(1));
    let family = |answer: &Json| answer.pointer("/1/nodes/1/runs/0/appearance/fontFamily").cloned();
    assert_eq!(family(&sketch), Some(json!("Roboto")), "{sketch}");
    let held = s(vec![json!("Other"), json!("Yomogi")]);
    let yomogi = drawn(&[("style", json!("visual.sketch")), ("fontFamilies", held)]);
    assert_eq!(yomogi.get(3), Some(&json!([])));
    assert_eq!(family(&yomogi), Some(json!("Yomogi")), "{yomogi}");
    let neon = drawn(&[("style", json!("visual.neon"))]);
    assert_eq!(neon.get(3), Some(&json!([])));
    assert_ne!(neon.get(1), clean.get(1));
    assert_ne!(neon.get(1), sketch.get(1));
    for not_a_style in [json!(1), s(Vec::new())] {
        let asking = request(board("x"), &[("style", not_a_style)]);
        assert_eq!(answer(&asking), json!(["refused", "malformed", "request"]));
    }
    let not_families = request(board("x"), &[("fontFamilies", s(vec![json!(1)]))]);
    assert_eq!(answer(&not_families), json!(["refused", "malformed", "request"]));
    let three = s(vec![json!("A"), json!("B"), json!("Yomogi")]);
    let past = request(board("x"), &[("style", json!("visual.sketch")), ("fontFamilies", three)]);
    assert_eq!(answer(&past), json!(["refused", "input-too-large", "font-families"]));
}

fn spatial(fields: &[(&str, Json)]) -> Json {
    let mut all = vec![("kind", json!("spatial")), ("x", json!(0)), ("y", json!(0))];
    for (key, value) in fields {
        all.retain(|(name, _)| name != key);
        all.push((key, value.clone()));
    }
    m(&all)
}

fn thread(id: &str, anchor: Json, status: &str, bodies: &[&str]) -> Json {
    let messages = bodies
        .iter()
        .enumerate()
        .map(|(i, body)| m(&[("id", json!(format!("{id}-m{i}"))), ("body", json!(body))]))
        .collect();
    m(&[
        ("id", json!(id)),
        ("anchor", anchor),
        ("status", json!(status)),
        ("messages", s(messages)),
    ])
}

/// The scene node `id` of an answer, at any depth.
fn scene_node<'a>(answer: &'a Json, id: &str) -> Option<&'a Json> {
    fn find<'a>(value: &'a Json, id: &str) -> Option<&'a Json> {
        match value {
            Json::Object(o) if o.get("id") == Some(&json!(id)) => Some(value),
            Json::Object(o) => o.values().find_map(|v| find(v, id)),
            Json::Array(items) => items.iter().find_map(|v| find(v, id)),
            _ => None,
        }
    }
    find(answer.get(1)?, id)
}

fn on_a(extra: &[(&str, Json)]) -> Json {
    answer(&request(board("hello"), extra))
}

#[test]
fn a_thread_is_drawn_as_its_pin_bubble_and_leader() {
    let one = s(vec![thread("t", spatial(&[("nodeId", json!("a"))]), "open", &["about t"])]);
    let drawn = on_a(&[("threads", one.clone())]);
    assert_eq!(drawn.get(0), Some(&json!("ok")), "{drawn}");
    for part in ["t/pin", "t/bubble", "t/leader"] {
        assert!(scene_node(&drawn, part).is_some(), "{part}: {drawn}");
    }
    assert!(drawn.to_string().contains("\"about t\""), "{drawn}");
    // The pin stands at the node's top-right corner.
    assert_eq!(scene_node(&drawn, "t/pin").and_then(|p| p.pointer("/bbox/x")), Some(&json!(150)));
    let bare = on_a(&[]);
    assert_eq!(on_a(&[("threads", one.clone()), ("commentLayer", json!(false))]), bare);
    assert_eq!(on_a(&[("threads", one.clone()), ("commentLayer", json!(true))]), drawn);
    assert_eq!(on_a(&[("threads", s(Vec::new()))]), bare);
    let two = s(vec![thread("t", spatial(&[("nodeId", json!("a"))]), "open", &["x", "y"])]);
    assert!(on_a(&[("threads", two)]).to_string().contains("\"2\""));
}

#[test]
fn a_settled_thread_is_drawn_only_when_asked_for() {
    let settled = s(vec![thread("t", spatial(&[]), "resolved", &["done"])]);
    let bare = on_a(&[]);
    assert_eq!(on_a(&[("threads", settled.clone())]), bare);
    assert_eq!(on_a(&[("threads", settled.clone()), ("showResolved", json!(false))]), bare);
    let shown = on_a(&[("threads", settled), ("showResolved", json!(true))]);
    assert!(scene_node(&shown, "t/bubble").is_some(), "{shown}");
    assert!(shown.to_string().contains("\"Resolved\""), "{shown}");
}

#[test]
fn a_bubble_keeps_clear_of_the_obstacles_it_is_handed() {
    let one =
        s(vec![thread("t", spatial(&[("x", json!(400)), ("y", json!(400))]), "open", &["x"])]);
    let bubble = |extra: &[(&str, Json)]| {
        let mut all = vec![("threads", one.clone())];
        all.extend(extra.iter().cloned());
        scene_node(&on_a(&all), "t/bubble").and_then(|b| b.get("bbox")).cloned()
    };
    let free = bubble(&[]);
    assert_eq!(bubble(&[("commentObstacles", s(Vec::new()))]), free);
    // An obstacle over where the bubble stood moves it, and one over where it
    // moved to moves it again.
    let over = |at: &Option<Json>| {
        let at = at.clone().unwrap_or_default();
        let wire = |key: &str| {
            let n = at[key].as_f64().unwrap_or_default();
            json!(["f", format!("{:016x}", n.to_bits())])
        };
        m(&[("x", wire("x")), ("y", wire("y")), ("w", wire("w")), ("h", wire("h"))])
    };
    let moved = bubble(&[("commentObstacles", s(vec![over(&free)]))]);
    assert!(moved.is_some());
    assert_ne!(moved, free);
    let again = bubble(&[("commentObstacles", s(vec![over(&free), over(&moved)]))]);
    assert_ne!(again, moved);
    assert_ne!(again, free);
}

#[test]
fn every_anchor_arm_is_read() {
    let quote = m(&[("prefix", json!("")), ("exact", json!("hello")), ("suffix", json!(""))]);
    let passage = m(&[
        ("kind", json!("text")),
        ("nodeId", json!("a")),
        ("quote", quote),
        ("start", json!(0)),
        ("end", json!(5)),
    ]);
    let region = spatial(&[("x", json!(300)), ("width", json!(50)), ("height", json!(40))]);
    let set = spatial(&[("nodeIds", s(vec![json!("a"), json!("gone")]))]);
    let threads = s(vec![
        thread("p", passage, "open", &["a passage"]),
        thread("r", region, "open", &["a region"]),
        thread("n", set, "open", &["a set"]),
        thread("e", spatial(&[("edgeId", json!("no-edge"))]), "open", &["an edge"]),
        thread("d", m(&[("kind", json!("document"))]), "open", &["the document"]),
    ]);
    let drawn = on_a(&[("threads", threads)]);
    for part in ["p/passage-0", "r/region", "r/pin", "n/region", "n/pin", "e/pin"] {
        assert!(scene_node(&drawn, part).is_some(), "{part}: {drawn}");
    }
    assert!(scene_node(&drawn, "d/pin").is_none(), "{drawn}");
    assert_eq!(scene_node(&drawn, "r/region").and_then(|r| r.pointer("/bbox/w")), Some(&json!(50)));
    assert_eq!(
        scene_node(&drawn, "n/region").and_then(|r| r.pointer("/bbox/w")),
        Some(&json!(160))
    );
}

#[test]
fn a_comment_layer_that_is_not_one_is_no_request() {
    let ok = |anchor: Json| s(vec![thread("t", anchor, "open", &["x"])]);
    let text = |start: Json| {
        let quote = m(&[("exact", json!("h"))]);
        m(&[("kind", json!("text")), ("quote", quote), ("start", start), ("end", json!(1))])
    };
    assert_eq!(on_a(&[("threads", ok(text(json!(0))))]).get(0), Some(&json!("ok")));
    let mut extra_thread = thread("t", spatial(&[]), "open", &["x"]);
    if let Json::Array(items) = &mut extra_thread {
        items.extend([json!("createdAt"), json!("2026")]);
    }
    let bad_message = m(&[
        ("id", json!("t")),
        ("anchor", spatial(&[])),
        ("status", json!("open")),
        (
            "messages",
            s(vec![m(&[("id", json!("m")), ("body", json!("x")), ("author", json!("me"))])]),
        ),
    ]);
    for not_threads in [
        s(vec![thread("t", spatial(&[]), "closed", &["x"])]),
        ok(m(&[("kind", json!("elsewhere"))])),
        ok(m(&[("kind", json!("document")), ("x", json!(0))])),
        ok(spatial(&[("x", json!("0"))])),
        ok(spatial(&[("colour", json!("red"))])),
        ok(text(json!(-1))),
        ok(text(json!(["f", "3fe0000000000000"]))),
        ok(m(&[
            ("kind", json!("text")),
            ("quote", m(&[("exact", json!("h")), ("x", json!(1))])),
            ("start", json!(0)),
            ("end", json!(1)),
        ])),
        s(vec![extra_thread]),
        s(vec![bad_message]),
        json!("threads"),
    ] {
        let asking = request(board("x"), &[("threads", not_threads.clone())]);
        assert_eq!(answer(&asking), json!(["refused", "malformed", "request"]), "{not_threads}");
    }
}

#[test]
fn a_comment_option_that_is_not_one_is_no_request() {
    let not_box = s(vec![m(&[("x", json!(0)), ("y", json!(0)), ("w", json!(1))])]);
    for (key, value) in
        [("commentObstacles", not_box), ("showResolved", json!(1)), ("commentLayer", json!("no"))]
    {
        let asking = request(board("x"), &[(key, value)]);
        assert_eq!(answer(&asking), json!(["refused", "malformed", "request"]), "{key}");
    }
}

/// Comment-layer inputs that draw nothing even when a layout accepts them, so a
/// cap that stops refusing fails its assertion at once rather than laying a
/// crowd out: a thread about the document has no place, a passage of no node
/// is no highlight, and obstacles with no thread are never asked.
fn unplaced(n: usize, anchor: &Json) -> Json {
    s((0..n).map(|i| thread(&format!("t{i}"), anchor.clone(), "open", &["x"])).collect())
}

#[test]
fn a_comment_layer_is_held_to_its_caps() {
    let refused = json!(["refused", "input-too-large", "comments"]);
    let ok = |answer: Json| assert_eq!(answer.get(0), Some(&json!("ok")), "{answer:.200}");
    let document = m(&[("kind", json!("document"))]);
    ok(on_a(&[("threads", unplaced(MAX_COMMENT_ITEMS, &document))]));
    assert_eq!(on_a(&[("threads", unplaced(MAX_COMMENT_ITEMS + 1, &document))]), refused);
    let cover = m(&[("x", json!(0)), ("y", json!(0)), ("w", json!(1)), ("h", json!(1))]);
    let boxes = |n: usize| s(vec![cover.clone(); n]);
    ok(on_a(&[("commentObstacles", boxes(MAX_COMMENT_ITEMS))]));
    assert_eq!(on_a(&[("commentObstacles", boxes(MAX_COMMENT_ITEMS + 1))]), refused);
    let ids =
        |n: usize| spatial(&[("nodeIds", s((0..n).map(|i| json!(format!("n{i}"))).collect()))]);
    let per = MAX_COMMENT_ITEMS / 4;
    let set = |last: usize| {
        s(vec![
            thread("a", ids(per), "open", &["x"]),
            thread("b", ids(per), "open", &["x"]),
            thread("c", ids(last), "open", &["x"]),
        ])
    };
    // The ids are counted across threads.
    ok(on_a(&[("threads", set(MAX_COMMENT_ITEMS - 2 * per))]));
    assert_eq!(on_a(&[("threads", set(MAX_COMMENT_ITEMS - 2 * per + 1))]), refused);
    // A passage is looked for through its node's whole text, so passages are
    // held apart, and only passages are: the threads beside them are not counted.
    let quote = m(&[("exact", json!("h"))]);
    let passage =
        m(&[("kind", json!("text")), ("quote", quote), ("start", json!(0)), ("end", json!(1))]);
    let mixed = |n: usize| {
        let mut all = vec![thread("d", document.clone(), "open", &["x"])];
        all.extend((0..n).map(|i| thread(&format!("p{i}"), passage.clone(), "open", &["x"])));
        s(all)
    };
    ok(on_a(&[("threads", mixed(MAX_PASSAGES))]));
    assert_eq!(on_a(&[("threads", mixed(MAX_PASSAGES + 1))]), refused);
}

#[test]
fn only_a_threads_opening_message_counts_with_the_bodies() {
    // The board holds one byte, so an opening message of the rest is at the cap.
    let rest = "a".repeat(MAX_BODY_BYTES - 1);
    let document = m(&[("kind", json!("document"))]);
    let asking = |bodies: &[&str]| {
        let threads = s(vec![thread("t", document.clone(), "open", bodies)]);
        answer(&request(board("x"), &[("threads", threads)]))
    };
    assert_eq!(asking(&[&rest]).get(0), Some(&json!("ok")));
    let over = format!("{rest}a");
    assert_eq!(asking(&[&over]), json!(["refused", "input-too-large", "bodies"]));
    assert_eq!(asking(&["x", &over]).get(0), Some(&json!("ok")));
}
