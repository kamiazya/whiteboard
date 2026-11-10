//! The JSON Canvas codec on inputs written by hand, one behaviour each. The
//! recorded oracle holds the codec to the TypeScript over thousands of inputs;
//! these say what the behaviours are, in words.

use serde_json::json;
use whiteboard_codec::json_canvas::{
    Code, Decline, Failure, Issue, MAX_BYTES, MAX_DEPTH, MAX_WRITE_DEPTH, Mode, PathStep,
    SpatialCanvas, WriteFailure, parse, serialize,
};
use whiteboard_model::Value;
use whiteboard_model::spatial::{
    Arrowhead, BackgroundStyle, CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine,
    CanvasPoint, EdgeEnd, EdgeSide, LineEnd, LineEndNode, LineEndPoint, NodeEmbed, NodeResource,
    SpatialNode,
};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOX: &str = r#""x":0,"y":0,"width":10,"height":10"#;

fn key(name: &'static str) -> PathStep {
    PathStep::Key(name)
}

fn issue(path: Vec<PathStep>, code: Code) -> Issue {
    Issue { path, code, message: None }
}

/// A refinement the wire schema states in code, with the message it states.
fn refinement(path: Vec<PathStep>, message: &str) -> Issue {
    Issue { path, code: Code::Custom, message: Some(message.to_string()) }
}

fn refused(text: &str) -> Vec<Issue> {
    let parsed = parse(text);
    assert!(matches!(parsed, Err(Failure::Schema(_))), "{text} was not refused: {parsed:?}");
    match parsed {
        Err(Failure::Schema(issues)) => issues,
        _ => Vec::new(),
    }
}

fn read(text: &str) -> SpatialCanvas {
    let parsed = parse(text);
    assert!(parsed.is_ok(), "{text} was refused: {parsed:?}");
    parsed.unwrap_or_default()
}

fn one_node(fields: &str) -> String {
    format!(r#"{{"nodes":[{{"id":"a",{BOX},{fields}}}]}}"#)
}

fn node_of(text: &str) -> SpatialNode {
    let nodes = read(text).nodes;
    assert_eq!(nodes.len(), 1, "{text}");
    nodes.into_iter().next().unwrap_or_default()
}

fn link(url: &str) -> Result<SpatialCanvas, Failure> {
    parse(&one_node(&format!(r#""type":"link","url":{}"#, json!(url))))
}

fn text_node(id: &str) -> SpatialNode {
    SpatialNode {
        id: id.to_string(),
        width: 10.0,
        height: 10.0,
        resource: Some(NodeResource {
            mime_type: "text/markdown".to_string(),
            content: Some("t".to_string()),
            ..NodeResource::default()
        }),
        ..SpatialNode::default()
    }
}

fn canvas_of(nodes: Vec<SpatialNode>) -> SpatialCanvas {
    SpatialCanvas { nodes, ..SpatialCanvas::default() }
}

fn written(canvas: &SpatialCanvas, mode: Mode) -> String {
    let text = serialize(canvas, mode);
    assert!(text.is_ok(), "{canvas:?} has no spelling: {text:?}");
    text.unwrap_or_default()
}

// ------------------------------------------------------------------ reading

#[test]
fn an_empty_object_is_an_empty_canvas() {
    assert_eq!(read("{}"), SpatialCanvas::default());
    assert_eq!(read(" \t\r\n{ } \n"), SpatialCanvas::default());
}

#[test]
fn the_four_node_types_lift_into_resources_and_frames() {
    let text = node_of(&one_node(r#""type":"text","text":"hi""#));
    let resource = text.resource.expect("text shows a resource");
    assert_eq!(resource.mime_type, "text/markdown");
    assert_eq!(resource.content.as_deref(), Some("hi"));

    let file = node_of(&one_node(r##""type":"file","file":"a.md","subpath":"#top""##));
    let resource = file.resource.expect("a file shows a resource");
    assert_eq!(resource.mime_type, "application/octet-stream");
    assert_eq!(resource.location.as_deref(), Some("a.md"));
    assert_eq!(resource.subpath.as_deref(), Some("#top"));

    let link = node_of(&one_node(r#""type":"link","url":"https://example.com""#));
    assert_eq!(link.resource.expect("a link shows a resource").mime_type, "text/uri-list");

    let frame = node_of(&one_node(
        r#""type":"group","label":"L","background":"bg.png","backgroundStyle":"ratio""#,
    ));
    assert_eq!(frame.resource, None);
    assert_eq!(frame.label.as_deref(), Some("L"));
    assert_eq!(frame.background.as_deref(), Some("bg.png"));
    assert_eq!(frame.background_style.map(BackgroundStyle::as_str), Some("ratio"));
}

#[test]
fn geometry_is_rounded_to_a_whole_pixel_and_never_to_negative_zero() {
    let node =
        node_of(r#"{"nodes":[{"id":"a","x":-0,"y":-0.0,"width":0,"height":-0,"type":"group"}]}"#);
    for value in [node.x, node.y, node.width, node.height] {
        assert!(value == 0.0 && value.is_sign_positive(), "{value}");
    }
}

#[test]
fn a_color_is_a_preset_or_a_hex_and_a_bad_string_is_a_format_error() {
    let node = node_of(&one_node(r##""type":"group","color":"#a1B2c3""##));
    assert_eq!(node.color, Some(CanvasColor::CanvasColorHex("#a1B2c3".to_string())));
    let node = node_of(&one_node(r#""type":"group","color":"4""#));
    assert_eq!(node.color, Some(CanvasColor::CanvasColorPreset(CanvasColorPreset::V4)));
    let path = vec![key("nodes"), PathStep::Index(0), key("color")];
    let bad = one_node(r##""type":"group","color":"#abc""##);
    assert_eq!(refused(&bad), vec![issue(path.clone(), Code::InvalidFormat)]);
    let bad = one_node(r#""type":"group","color":5"#);
    assert_eq!(refused(&bad), vec![issue(path, Code::InvalidUnion)]);
}

#[test]
fn an_x_whiteboard_bucket_that_is_malformed_costs_the_bucket_and_not_the_document() {
    let ext = |x: &str| node_of(&one_node(&format!(r#""type":"group","x-whiteboard":{x}"#)));
    let embed =
        ext(&format!(r#"{{"kind":"embed","documentId":"{ULID}","versionRef":"v1","tags":["a"]}}"#));
    assert_eq!(
        embed.embed,
        Some(NodeEmbed { document_id: ULID.to_string(), version_ref: Some("v1".to_string()) })
    );
    assert_eq!(embed.tags, Some(vec!["a".to_string()]));
    // A strict arm refuses a key it does not know: the bucket is lost whole.
    let lost = ext(r#"{"tags":["a"],"extra":1}"#);
    assert_eq!((lost.tags, lost.embed, lost.facets), (None, None, None));
    // An embed arm ignores one.
    let kept = ext(&format!(r#"{{"kind":"embed","documentId":"{ULID}","extra":1}}"#));
    assert!(kept.embed.is_some());
    // A document id that is no ULID, or an empty version, loses both arms.
    assert_eq!(ext(r#"{"kind":"embed","documentId":"x","tags":["a"]}"#).tags, None);
    assert_eq!(
        ext(&format!(r#"{{"kind":"embed","documentId":"{ULID}","versionRef":""}}"#)).embed,
        None
    );
    // Bad facets cost the facets alone.
    let bad_facets = ext(r#"{"facets":{"plain":1},"tags":["a"]}"#);
    assert_eq!((bad_facets.facets, bad_facets.tags), (None, Some(vec!["a".to_string()])));
    assert_eq!(ext("5").tags, None);
}

#[test]
fn a_facet_key_named_proto_is_skipped_as_zod_skips_it_and_a_payload_keeps_its_own() {
    let canvas = read(
        r#"{"x-whiteboard":{"facets":{"__proto__":1,"a.b/v0":{"__proto__":2,"10":0,"9":1,"z":2}}}}"#,
    );
    let facets = canvas.facets.expect("facets");
    assert_eq!(facets.len(), 1);
    let Value::Map(payload) = &facets[0].1 else { panic!("a map") };
    let keys: Vec<&str> = payload.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["9", "10", "__proto__", "z"]);
}

#[test]
fn an_edge_carries_its_extension_and_an_empty_bends_list_is_lost() {
    let edges = |ext: &str| {
        let text = format!(
            r#"{{"nodes":[{{"id":"a",{BOX},"type":"group"}}],"edges":[{{"id":"e","fromNode":"a","toNode":"a","fromSide":"top","toEnd":"arrow","x-whiteboard":{ext}}}]}}"#
        );
        read(&text).edges
    };
    let edge: &CanvasEdge = &edges(r#"{"bends":[{"x":1,"y":2,"z":3}],"tags":[]}"#)[0];
    assert_eq!(edge.bends, Some(vec![CanvasPoint { x: 1.0, y: 2.0 }]));
    assert_eq!(edge.tags, Some(Vec::new()));
    assert_eq!(edge.from.side.map(EdgeSide::as_str), Some("top"));
    assert_eq!(edge.to.end.map(Arrowhead::as_str), Some("arrow"));
    assert_eq!(edges(r#"{"bends":[]}"#)[0].bends, None);
    assert_eq!(edges(r#"{"bends":[{"x":1.5,"y":2}]}"#)[0].bends, None);
    assert_eq!(edges(r#"{"unknown":1}"#)[0].bends, None);
}

#[test]
fn a_list_of_bends_holds_at_most_sixty_four_points_on_an_edge_and_on_a_line() {
    let points = |count: usize| {
        let points: Vec<String> = (0..count).map(|at| format!(r#"{{"x":{at},"y":0}}"#)).collect();
        points.join(",")
    };
    let edge = |count: usize| {
        let text = format!(
            r#"{{"nodes":[{{"id":"a",{BOX},"type":"group"}}],"edges":[{{"id":"e","fromNode":"a","toNode":"a","x-whiteboard":{{"bends":[{}]}}}}]}}"#,
            points(count)
        );
        read(&text).edges.remove(0).bends.map(|bends| bends.len())
    };
    assert_eq!((edge(1), edge(64), edge(65)), (Some(1), Some(64), None));
    let line = |count: usize| {
        let text = format!(
            r#"{{"x-whiteboard":{{"lines":[{{"id":"l","from":{{"kind":"point","point":{{"x":0,"y":0}}}},"to":{{"kind":"point","point":{{"x":1,"y":1}}}},"bends":[{}]}}]}}}}"#,
            points(count)
        );
        read(&text).lines.map(|lines| lines.len())
    };
    assert_eq!((line(1), line(64), line(65)), (Some(1), Some(1), None));
}

#[test]
fn ink_rides_the_root_extension_and_one_bad_line_costs_all_of_it() {
    let line = |extra: &str| {
        format!(
            r#"{{"id":"l","from":{{"kind":"node","node":"a","side":"left"}},"to":{{"kind":"point","point":{{"x":1.5,"y":-2}},"end":"arrow"}}{extra}}}"#
        )
    };
    let canvas =
        read(&format!(r#"{{"x-whiteboard":{{"lines":[{}]}}}}"#, line(r#","label":"ink""#)));
    let lines: Vec<CanvasLine> = canvas.lines.expect("lines");
    assert_eq!(lines[0].label.as_deref(), Some("ink"));
    assert!(
        matches!(&lines[0].from, LineEnd::LineEndNode(LineEndNode { node, .. }) if node == "a")
    );
    assert!(
        matches!(&lines[0].to, LineEnd::LineEndPoint(LineEndPoint { point, .. }) if point.x.to_bits() == 1.5f64.to_bits())
    );
    // A line is strict: a key it does not know loses every line.
    let canvas = read(&format!(
        r#"{{"x-whiteboard":{{"lines":[{},{}],"tags":["t"]}}}}"#,
        line(""),
        line(r#","tags":[]"#)
    ));
    assert_eq!((canvas.lines, canvas.tags), (None, Some(vec!["t".to_string()])));
}

#[test]
fn a_coordinate_spelled_past_the_largest_double_is_no_number_to_ink() {
    let ink = |x: &str| {
        let text = format!(
            r#"{{"x-whiteboard":{{"lines":[{{"id":"l","from":{{"kind":"point","point":{{"x":{x},"y":0}}}},"to":{{"kind":"point","point":{{"x":1,"y":1}}}}}}]}}}}"#
        );
        read(&text).lines.map(|lines| lines.len())
    };
    assert_eq!((ink("1e308"), ink("1e999"), ink("-1e999")), (Some(1), None, None));
}

#[test]
fn the_model_s_own_checks_on_ink_are_not_the_wire_s() {
    // `parseSpatial` validates the wire, not `spatialCanvasIntegrity`: a line
    // that names a node the canvas lacks, or an id an edge already holds, reads.
    let text = format!(
        r#"{{"nodes":[{{"id":"a",{BOX},"type":"group"}}],"edges":[{{"id":"x","fromNode":"a","toNode":"a"}}],"x-whiteboard":{{"lines":[{{"id":"x","from":{{"kind":"node","node":"ghost"}},"to":{{"kind":"node","node":"ghost"}}}}]}}}}"#
    );
    assert_eq!(read(&text).lines.map(|l| l.len()), Some(1));
}

#[test]
fn a_file_that_carries_a_conversation_is_refused_by_name_and_an_empty_one_is_not() {
    for text in [
        r#"{"x-whiteboard":{"comments":[{"id":"c"}]}}"#,
        r#"{"nodes":5,"x-whiteboard":{"comments":[1]}}"#,
    ] {
        assert_eq!(parse(text), Err(Failure::Conversation), "{text}");
    }
    for text in [
        r#"{"x-whiteboard":{"comments":[]}}"#,
        r#"{"x-whiteboard":{"comments":{}}}"#,
        r#"{"x-whiteboard":[{"comments":[1]}]}"#,
        r#"{"comments":[1]}"#,
    ] {
        assert!(parse(text).is_ok(), "{text}");
    }
}

#[test]
fn a_text_that_is_not_json_is_a_syntax_failure() {
    for text in [
        "",
        " ",
        "{",
        "{}x",
        "{} {}",
        "[1,]",
        "{\"a\":1,}",
        "{'a':1}",
        "\u{feff}{}",
        "\u{a0}{}",
        "{\"a\":01}",
        "{\"a\":+1}",
        "{\"a\":.5}",
        "{\"a\":1.}",
        "{\"a\":1e}",
        "{\"a\":-}",
        "{\"a\":NaN}",
        "{\"a\":tru}",
        "{\"a\":\"\\x\"}",
        "{\"a\":\"\\u12\"}",
        "{\"a\":\"\u{1}\"}",
        "{\"a\":\"\n\"}",
        "{\"a\":\"open}",
        "{\"a\" 1}",
        "{a:1}",
        "[,1]",
        "{\"a\":1}{",
    ] {
        assert_eq!(parse(text), Err(Failure::Syntax), "{text:?}");
    }
}

#[test]
fn json_as_the_host_reads_it() {
    // A repeated key keeps its first position and takes its last value.
    let canvas = read(r#"{"x-whiteboard":{"facets":{"a.b/v0":{"k":1,"j":2,"k":3}}}}"#);
    let Value::Map(payload) = &canvas.facets.expect("facets")[0].1 else { panic!("a map") };
    assert_eq!(
        *payload,
        vec![("k".to_string(), Value::Number(3.0)), ("j".to_string(), Value::Number(2.0))]
    );
    // Escapes, a pair of surrogate escapes, and every number form.
    let canvas = read(
        r#"{"x-whiteboard":{"facets":{"a.b/v0":["\b\f\n\r\t\"\\\/\u00e9\ud83d\ude00",1E2,-0,0.5e1,1e999,-1e-999]}}}"#,
    );
    let Value::Seq(items) = &canvas.facets.expect("facets")[0].1 else { panic!("a list") };
    assert_eq!(items[0], Value::String("\u{8}\u{c}\n\r\t\"\\/\u{e9}\u{1f600}".to_string()));
    let numbers: Vec<f64> =
        items[1..].iter().map(|v| if let Value::Number(n) = v { *n } else { f64::NAN }).collect();
    assert_eq!(numbers[..3], [100.0, -0.0, 5.0]);
    assert!(numbers[2].is_finite() && numbers[3] == f64::INFINITY && numbers[4] == 0.0);
    assert!(numbers[1].is_sign_negative());
}

// ------------------------------------------------------------------ refusing

#[test]
fn the_schema_names_each_place_it_refused_in_its_own_order() {
    let text = r#"{"nodes":[{"id":"","x":1.5,"y":"0","width":-1,"height":1e300,"type":"group"},5,{"type":"image"}],"edges":[{"id":"e","fromNode":1,"toSide":"up"}]}"#;
    let node = |at: usize, name: &'static str| vec![key("nodes"), PathStep::Index(at), key(name)];
    assert_eq!(
        refused(text),
        vec![
            issue(node(0, "id"), Code::TooSmall),
            issue(node(0, "x"), Code::InvalidType),
            issue(node(0, "y"), Code::InvalidType),
            issue(node(0, "width"), Code::TooSmall),
            issue(node(0, "height"), Code::TooBig),
            issue(vec![key("nodes"), PathStep::Index(1)], Code::InvalidType),
            issue(node(2, "type"), Code::InvalidUnion),
            issue(vec![key("edges"), PathStep::Index(0), key("fromNode")], Code::InvalidType),
            issue(vec![key("edges"), PathStep::Index(0), key("toNode")], Code::InvalidType),
            issue(vec![key("edges"), PathStep::Index(0), key("toSide")], Code::InvalidValue),
        ]
    );
}

#[test]
fn a_number_too_large_to_be_a_pixel_is_refused_once_or_twice_by_its_checks() {
    let at = |name: &'static str| vec![key("nodes"), PathStep::Index(0), key(name)];
    let node = r#"{"nodes":[{"id":"a","x":1e300,"y":-1e300,"width":-1e300,"height":9007199254740992,"type":"group"}]}"#;
    assert_eq!(
        refused(node),
        vec![
            issue(at("x"), Code::TooBig),
            issue(at("y"), Code::TooSmall),
            issue(at("width"), Code::TooSmall),
            issue(at("width"), Code::TooSmall),
            issue(at("height"), Code::TooBig),
        ]
    );
    let infinite = r#"{"nodes":[{"id":"a","x":1e999,"y":0,"width":1,"height":1,"type":"group"}]}"#;
    assert_eq!(refused(infinite), vec![issue(at("x"), Code::InvalidType)]);
}

#[test]
fn a_document_that_is_no_object_is_refused_at_its_root() {
    for text in ["null", "5", "\"x\"", "[]", "true"] {
        assert_eq!(refused(text), vec![issue(Vec::new(), Code::InvalidType)], "{text}");
    }
    assert_eq!(refused(r#"{"nodes":null}"#), vec![issue(vec![key("nodes")], Code::InvalidType)]);
    assert_eq!(refused(r#"{"edges":{}}"#), vec![issue(vec![key("edges")], Code::InvalidType)]);
}

#[test]
fn a_repeated_key_in_a_large_object_still_keeps_its_first_place_and_last_value() {
    let members: Vec<String> = (0..40).map(|at| format!(r#""k{at}":{at}"#)).collect();
    let text = format!(
        r#"{{"x-whiteboard":{{"facets":{{"a.b/v0":{{{},"k33":"last","k2":"again","k39":null}}}}}}}}"#,
        members.join(",")
    );
    let Value::Map(payload) = read(&text).facets.unwrap_or_default().remove(0).1 else {
        panic!("a map")
    };
    assert_eq!(payload.len(), 40);
    assert_eq!(payload[33], ("k33".to_string(), Value::String("last".to_string())));
    assert_eq!(payload[2], ("k2".to_string(), Value::String("again".to_string())));
    assert_eq!(payload[39], ("k39".to_string(), Value::Null));
    assert_eq!(payload[0], ("k0".to_string(), Value::Number(0.0)));
}

// ------------------------------------------------------------------ links

#[test]
fn a_link_is_a_url_the_host_parses() {
    for ok in [
        "https://example.com",
        "HTTP://EXAMPLE.COM:8080/x?y#z",
        "https://user:pw@example.com",
        "http:example.com",
        "http:\\\\example.com",
        "http://1.2.3.4:65535",
        "http://1.2.3.4.",
        "http://0x7f.1",
        "http://4294967295",
        "http://a:",
        "http://a_b.com",
        "mailto:a@b.c",
        "foo:bar",
        "foo://",
        "foo://host:80/p",
        "foo://user@host",
        "a+b-c.d:rest",
    ] {
        assert!(link(ok).is_ok(), "{ok}");
    }
}

#[test]
fn a_link_that_is_no_url_is_a_format_error_at_its_url() {
    for bad in [
        "",
        "abc",
        "://x",
        "/rel",
        "1a:b",
        "http://",
        "http:",
        "http://@",
        "http://user@",
        "http://:80",
        "http://a:b",
        "http://a:65536",
        "http://a b",
        "http://a<b",
        "http://a^b",
        "http://256.1.1.1",
        "http://256.1.1.1.",
        "http://a.9.",
        "http://a.9",
        "http://1.2.3.4.5",
        "http://4294967296",
        "http://09",
        "foo://a b",
        "foo://:80",
        "foo://user@",
        "foo://host:x",
        "foo://a]b",
        "foo://a\\b",
    ] {
        let at = vec![key("nodes"), PathStep::Index(0), key("url")];
        assert_eq!(
            link(bad),
            Err(Failure::Schema(vec![issue(at, Code::InvalidFormat)])),
            "{bad:?}"
        );
    }
}

#[test]
fn a_links_value_is_its_text_trimmed_and_without_tabs_and_line_breaks() {
    let read = link("\u{a0}\t https://exa\nmple.com \u{2003}");
    assert!(read.is_ok(), "{read:?}");
    let canvas = read.unwrap_or_default();
    let location = canvas.nodes[0].resource.as_ref().and_then(|r| r.location.clone());
    assert_eq!(location.as_deref(), Some("https://example.com"));
}

#[test]
fn a_link_with_an_ipv6_percent_encoded_international_or_file_host_is_read() {
    for url in [
        "http://\u{e9}.com",
        "http://xn--nxasmq6b.com",
        "http://%41.com",
        "http://[::1]/",
        "file:///x",
        "foo://[::1]",
    ] {
        assert!(link(url).is_ok(), "{url}");
    }
    assert_eq!(
        refused(&one_node(r#""type":"link","url":"http://[::1""#)),
        vec![issue(vec![key("nodes"), PathStep::Index(0), key("url")], Code::InvalidFormat)]
    );
}

// ------------------------------------------------------------------ declining

#[test]
fn what_a_rust_string_cannot_hold_or_the_core_caps_is_declined() {
    let lone =
        [r#"{"a":"\ud800"}"#, r#"{"a":"\udc00"}"#, r#"{"a":"\ud83dx"}"#, r#"{"a":"\ud83d\u0041"}"#];
    for text in lone {
        assert_eq!(parse(text), Err(Failure::Declined(Decline::LoneSurrogate)), "{text}");
    }
    assert!(parse(r#"{"a":"\ud83d\ude00"}"#).is_ok());
    let deep = |levels: usize| format!("{}{}", "[".repeat(levels), "]".repeat(levels));
    assert_eq!(refused(&deep(MAX_DEPTH)), vec![issue(Vec::new(), Code::InvalidType)]);
    assert_eq!(parse(&deep(MAX_DEPTH + 1)), Err(Failure::Declined(Decline::TooDeep)));
    let padded = |bytes: usize| {
        let wrapper = r#"{"x-whiteboard":{"tags":[""#.len() + r#""]}}"#.len();
        format!(r#"{{"x-whiteboard":{{"tags":["{}"]}}}}"#, "x".repeat(bytes - wrapper))
    };
    assert_eq!(padded(MAX_BYTES).len(), MAX_BYTES);
    assert_eq!(read(&padded(MAX_BYTES)).tags.map(|t| t.len()), Some(1));
    assert_eq!(parse(&padded(MAX_BYTES + 1)), Err(Failure::Declined(Decline::TooLarge)));
    assert_eq!(
        parse(&format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_BYTES))),
        Err(Failure::Declined(Decline::TooLarge))
    );
}

#[test]
fn the_caps_are_the_ones_the_registry_declares() {
    let registry: serde_json::Value =
        serde_json::from_str(include_str!("../../../input-caps.json")).unwrap_or_default();
    let entry = &registry["entries"]["whiteboard-codec::json_canvas::parse"];
    assert_eq!(entry["maxBytes"], json!(MAX_BYTES));
    assert_eq!(entry["maxDepth"], json!(MAX_DEPTH));
    assert_eq!(MAX_BYTES, 4 * 1024 * 1024);
}

// ------------------------------------------------------------------ writing

fn full_canvas() -> SpatialCanvas {
    let mut node = text_node("a");
    node.x = 1.5;
    node.y = -0.5;
    node.color = Some(CanvasColor::CanvasColorPreset(CanvasColorPreset::V2));
    node.embed =
        Some(NodeEmbed { document_id: ULID.to_string(), version_ref: Some("v1".to_string()) });
    node.tags = Some(vec!["t".to_string()]);
    let mut frame =
        SpatialNode { id: "f".to_string(), label: Some("L".to_string()), ..SpatialNode::default() };
    frame.facets =
        Some(vec![("a.b/v0".to_string(), Value::Seq(vec![Value::Number(1e21), Value::Null]))]);
    let edge = CanvasEdge {
        id: "e".to_string(),
        from: EdgeEnd { node: "a".to_string(), ..EdgeEnd::default() },
        to: EdgeEnd { node: "f".to_string(), ..EdgeEnd::default() },
        bends: Some(vec![CanvasPoint { x: 0.5, y: 2.5 }]),
        ..CanvasEdge::default()
    };
    let line = CanvasLine {
        id: "l".to_string(),
        from: LineEnd::LineEndPoint(LineEndPoint {
            point: CanvasPoint { x: -0.0, y: 0.25 },
            end: None,
        }),
        to: LineEnd::LineEndNode(LineEndNode { node: "a".to_string(), ..LineEndNode::default() }),
        bends: Some(vec![CanvasPoint { x: 1.5, y: -0.0 }]),
        ..CanvasLine::default()
    };
    SpatialCanvas {
        nodes: vec![node, frame],
        edges: vec![edge],
        lines: Some(vec![line]),
        facets: Some(Vec::new()),
        tags: Some(Vec::new()),
    }
}

#[test]
fn the_extended_text_has_the_projections_keys_in_the_projections_order() {
    let expected = concat!(
        r#"{"nodes":[{"id":"a","x":2,"y":0,"width":10,"height":10,"color":"2","#,
        r#""x-whiteboard":{"kind":"embed","documentId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","versionRef":"v1","tags":["t"]},"#,
        r#""type":"text","text":"t"},"#,
        r#"{"id":"f","x":0,"y":0,"width":0,"height":0,"x-whiteboard":{"facets":{"a.b/v0":[1e+21,null]}},"type":"group","label":"L"}],"#,
        r#""edges":[{"id":"e","fromNode":"a","toNode":"f","x-whiteboard":{"bends":[{"x":1,"y":3}]}}],"#,
        r#""x-whiteboard":{"lines":[{"id":"l","from":{"kind":"point","point":{"x":0,"y":0.25}},"#,
        r#""to":{"kind":"node","node":"a"},"bends":[{"x":1.5,"y":0}]}],"facets":{},"tags":[]}}"#,
    );
    assert_eq!(written(&full_canvas(), Mode::Extended), expected);
}

#[test]
fn the_strict_text_is_json_canvas_alone() {
    let expected = concat!(
        r#"{"nodes":[{"id":"a","x":2,"y":0,"width":10,"height":10,"color":"2","type":"text","text":"t"},"#,
        r#"{"id":"f","x":0,"y":0,"width":0,"height":0,"type":"group","label":"L"}],"#,
        r#""edges":[{"id":"e","fromNode":"a","toNode":"f"}]}"#,
    );
    assert_eq!(written(&full_canvas(), Mode::Strict), expected);
}

#[test]
fn a_node_whose_resource_nothing_claims_is_written_as_a_group() {
    let unclaimed = SpatialNode {
        id: "u".to_string(),
        resource: Some(NodeResource { mime_type: "x/y".to_string(), ..NodeResource::default() }),
        label: Some("kept".to_string()),
        ..SpatialNode::default()
    };
    assert_eq!(
        written(&canvas_of(vec![unclaimed]), Mode::Extended),
        r#"{"nodes":[{"id":"u","x":0,"y":0,"width":0,"height":0,"type":"group","label":"kept"}],"edges":[]}"#
    );
    let both = NodeResource {
        mime_type: "text/uri-list".to_string(),
        content: Some("c".to_string()),
        location: Some("https://example.com".to_string()),
        ..NodeResource::default()
    };
    let node = SpatialNode { resource: Some(both), ..SpatialNode::default() };
    assert!(
        written(&canvas_of(vec![node]), Mode::Extended).contains(r#""type":"text","text":"c""#)
    );
}

#[test]
fn a_number_is_written_as_javascript_writes_it() {
    let mut node = text_node("a");
    node.facets = Some(vec![(
        "a.b/v0".to_string(),
        Value::Seq(
            [
                0.0,
                -0.0,
                1e21,
                1e-7,
                123.456,
                f64::NAN,
                f64::INFINITY,
                f64::NEG_INFINITY,
                5e-324,
                9_007_199_254_740_992.0,
            ]
            .into_iter()
            .map(Value::Number)
            .collect(),
        ),
    )]);
    let text = written(&canvas_of(vec![node]), Mode::Extended);
    assert!(
        text.contains("[0,0,1e+21,1e-7,123.456,null,null,null,5e-324,9007199254740992]"),
        "{text}"
    );
}

#[test]
fn a_string_is_quoted_as_json_stringify_quotes_it() {
    let mut node = text_node("a");
    node.resource = Some(NodeResource {
        mime_type: "text/markdown".to_string(),
        content: Some("\"\\\u{8}\u{c}\n\r\t\u{0}\u{1f}\u{7f}\u{2028}\u{e9}\u{1f600}/".to_string()),
        ..NodeResource::default()
    });
    let text = written(&canvas_of(vec![node]), Mode::Extended);
    assert!(
        text.contains("\"\\\"\\\\\\b\\f\\n\\r\\t\\u0000\\u001f\u{7f}\u{2028}\u{e9}\u{1f600}/\""),
        "{text}"
    );
}

#[test]
fn an_object_is_written_with_integer_keys_first() {
    let mut node = text_node("a");
    let payload = Value::Map(
        ["b", "10", "a", "2"].map(|k| (k.to_string(), Value::Null)).into_iter().collect(),
    );
    node.facets = Some(vec![("a.b/v0".to_string(), payload)]);
    let text = written(&canvas_of(vec![node]), Mode::Extended);
    assert!(text.contains(r#"{"2":null,"10":null,"b":null,"a":null}"#), "{text}");
}

#[test]
fn the_strict_mode_refuses_a_canvas_the_wire_schema_refuses_and_the_extended_does_not() {
    let mut ghost = canvas_of(vec![text_node("a")]);
    ghost.edges.push(CanvasEdge {
        id: "e".to_string(),
        from: EdgeEnd { node: "a".to_string(), ..EdgeEnd::default() },
        to: EdgeEnd { node: "ghost".to_string(), ..EdgeEnd::default() },
        ..CanvasEdge::default()
    });
    assert!(serialize(&ghost, Mode::Extended).is_ok());
    assert_eq!(
        serialize(&ghost, Mode::Strict),
        Err(WriteFailure::Schema(vec![refinement(
            vec![key("edges"), PathStep::Index(0), key("toNode")],
            r#"edge "e" references nonexistent toNode "ghost""#,
        )]))
    );
    let twice = canvas_of(vec![text_node("a"), text_node("a")]);
    assert_eq!(
        serialize(&twice, Mode::Strict),
        Err(WriteFailure::Schema(vec![refinement(vec![key("nodes")], r#"duplicate node id "a""#)]))
    );
    let mut not_a_pixel = text_node("a");
    not_a_pixel.x = f64::NAN;
    let at = vec![key("nodes"), PathStep::Index(0), key("x")];
    assert_eq!(
        serialize(&canvas_of(vec![not_a_pixel]), Mode::Strict),
        Err(WriteFailure::Schema(vec![issue(at, Code::InvalidType)]))
    );
}

#[test]
fn a_link_the_strict_mode_cannot_judge_is_declined_and_one_it_judges_is_checked() {
    let linked = |url: &str| {
        let resource = NodeResource {
            mime_type: "text/uri-list".to_string(),
            location: Some(url.to_string()),
            ..NodeResource::default()
        };
        canvas_of(vec![SpatialNode {
            id: "a".to_string(),
            resource: Some(resource),
            ..SpatialNode::default()
        }])
    };
    assert!(serialize(&linked("https://example.com"), Mode::Strict).is_ok());
    let at = vec![key("nodes"), PathStep::Index(0), key("url")];
    assert_eq!(
        serialize(&linked("nonsense"), Mode::Strict),
        Err(WriteFailure::Schema(vec![issue(at, Code::InvalidFormat)]))
    );
    assert!(serialize(&linked("http://[::1]"), Mode::Strict).is_ok());
    assert!(serialize(&linked("nonsense"), Mode::Extended).is_ok());
}

#[test]
fn a_value_nested_past_the_writers_cap_is_declined() {
    let nested = |levels: usize| {
        let mut value = Value::Null;
        for _ in 0..levels {
            value = Value::Seq(vec![value]);
        }
        let mut node = text_node("a");
        node.facets = Some(vec![("a.b/v0".to_string(), value)]);
        canvas_of(vec![node])
    };
    assert!(serialize(&nested(MAX_WRITE_DEPTH - 8), Mode::Extended).is_ok());
    assert_eq!(
        serialize(&nested(MAX_WRITE_DEPTH + 1), Mode::Extended),
        Err(WriteFailure::Declined(Decline::TooDeep))
    );
    let huge = Value::BigInt("9007199254740993".to_string());
    let mut node = text_node("a");
    node.facets = Some(vec![("a.b/v0".to_string(), huge)]);
    assert_eq!(
        serialize(&canvas_of(vec![node]), Mode::Extended),
        Err(WriteFailure::Declined(Decline::Unwritable))
    );
}
