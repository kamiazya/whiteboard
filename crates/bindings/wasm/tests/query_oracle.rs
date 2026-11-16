//! `layout_query` against the recorded TypeScript answers (ADR-0054 step 7,
//! S18d): the layout pieces the web and the daemon call directly rather than
//! through a whole layout, each record's request built as a root builds it.
//!
//! - `layout-spatial-edges.jsonl`: the drag layers' edge-only layout
//!   (`layoutSpatialEdges`) under the editor's options and the side overrides
//!   a gesture hands, the edge layer compared as the text `scene_wire` writes;
//! - `node-size.jsonl`: `fittedTextNodeHeight` and `naturalNodeContentSize`;
//! - `edge-label-placement.jsonl`: `edgeLabelPlacement`, and the obstacles
//!   `labelObstacles` and `frameTitleObstacles` answer;
//! - `comment-placement.jsonl`'s `place` records: `placeCommentBubble`;
//! - `outline-content-box.jsonl`: `outlineContentBox`.
//!
//! Every double but the edge layer's is the hex of its bits, so a placement
//! is held bit for bit, a non-finite one included.

use std::path::Path;

use serde_json::{Value as Json, json};
use whiteboard_model::Value;
use whiteboard_wasm::json_canvas_wire::value_json;
use whiteboard_wasm::spatial_layout::layout_query;

fn oracle(name: &str) -> Vec<Value> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/canvas-render/src/oracle")
        .join(name);
    std::fs::read_to_string(dir).unwrap_or_default().lines().map(parse).collect()
}

/// A JSON line read as `JSON.parse` reads it, keys in written order.
fn parse(line: &str) -> Value {
    whiteboard_model::json::parse(line).unwrap_or_default()
}

fn get<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    match value {
        Value::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn text(value: &Value, key: &str) -> String {
    match get(value, key) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn s(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn map(fields: Vec<(&str, Value)>) -> Value {
    Value::Map(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn fake_measure() -> Value {
    map(vec![("kind", s("fake")), ("factor", Value::Number(0.6))])
}

/// The double a hex record spells.
fn number(hex: &Value) -> Value {
    match hex {
        Value::String(h) => Value::Number(f64::from_bits(u64::from_str_radix(h, 16).unwrap_or(0))),
        _ => Value::Null,
    }
}

/// A list of hex doubles as a list of numbers.
fn numbers(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Seq(items)) => Value::Seq(items.iter().map(number).collect()),
        _ => Value::Null,
    }
}

/// A list of lists of hex doubles as a list of lists of numbers.
fn rows(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Seq(items)) => Value::Seq(items.iter().map(|row| numbers(Some(row))).collect()),
        _ => Value::Null,
    }
}

fn ask(request: &Value) -> Json {
    let answer = layout_query(&value_json(request).to_string(), None);
    serde_json::from_str(&answer).unwrap_or(Json::Null)
}

/// The library the compose-canvas recording's meta line holds: the corpus's `TAG_LIBRARY`.
fn library() -> Value {
    let meta = oracle("compose-canvas.jsonl").into_iter().next().unwrap_or_default();
    get(&meta, "library").cloned().unwrap_or_default()
}

/// The families the bundled themes name that a profile holds: `styleOptions`.
fn font_families(profile: &Value) -> Option<Value> {
    match get(profile, "fonts") {
        Some(Value::Seq(fonts)) if fonts.contains(&s("Yomogi")) => {
            Some(Value::Seq(vec![s("Yomogi")]))
        }
        _ => None,
    }
}

fn edges_request(record: &Value, library: &Value) -> Value {
    let profile = get(record, "profile").cloned().unwrap_or_default();
    let mut fields = vec![
        ("query", s("edges")),
        ("canvas", get(record, "canvas").cloned().unwrap_or_default()),
        ("measure", fake_measure()),
        ("mode", s(&text(&profile, "mode"))),
        ("expand", Value::Bool(false)),
        ("style", s("document")),
    ];
    if let Some(families) = font_families(&profile) {
        fields.push(("fontFamilies", families));
    }
    fields.push(("sideOverrides", get(record, "overrides").cloned().unwrap_or_default()));
    if get(&profile, "library") == Some(&Value::Bool(true)) {
        fields.push(("tagLibrary", library.clone()));
    }
    map(fields)
}

/// A JSON text as a value: keys compared in any order, every double exact.
fn json(text: &str) -> Json {
    serde_json::from_str(text).unwrap_or(Json::Null)
}

#[test]
fn the_drag_frames_edge_layer_is_the_recorded_one() {
    let records = oracle("layout-spatial-edges.jsonl");
    assert_eq!(records.len(), 240, "the recording is read");
    let library = library();
    let (mut moved, mut reported) = (Vec::new(), Vec::new());
    for record in &records {
        let request = value_json(&edges_request(record, &library)).to_string();
        let answer = json(&layout_query(&request, None));
        // The core writes a scene's keys in its own order; the values are held.
        if answer[0] != json!("ok") || answer[1] != json(&text(record, "answer")) {
            moved.push(text(record, "id"));
        }
        // The recording holds the edge layer alone; what the layout reported
        // beside it is the theme's, compared with the TypeScript's by the shim's replay.
        let events = answer[2].as_array().cloned().unwrap_or_default();
        reported.extend(events.iter().map(|event| event["kind"].to_string()));
    }
    assert!(moved.is_empty(), "{} of {} frames differ: {moved:?}", moved.len(), records.len());
    reported.sort();
    reported.dedup();
    assert_eq!(reported, ["\"font-missing\"", "\"unknown-theme\""]);
}

fn node_size_request(record: &Value) -> Value {
    let kind = text(record, "kind");
    let mut fields = vec![
        ("query", s(if kind == "fitted" { "node-size" } else { "node-content" })),
        ("node", get(record, "node").cloned().unwrap_or_default()),
        ("measure", fake_measure()),
        ("mode", s(&text(record, "mode"))),
    ];
    if kind == "fitted" {
        fields.push(("floor", s(&text(record, "floor"))));
    }
    if let Some(style) = get(record, "style") {
        fields.push(("style", style.clone()));
        // `styleOptions`: the families a style other than clean names, when held.
        if text(record, "style") != "clean"
            && let Some(families) = font_families(record)
        {
            fields.push(("fontFamilies", families));
        }
    }
    if let Some(fragments) = get(record, "fragments") {
        fields.push(("fragments", fragments.clone()));
    }
    map(fields)
}

/// The recorded hex answer as the core spells it: `["ok", [hex...]]`.
fn hex_answer(record: &Value) -> Json {
    let answer = match get(record, "answer") {
        Some(Value::Seq(items)) => {
            items.iter().map(|h| json!(text(&map(vec![("h", h.clone())]), "h"))).collect()
        }
        _ => Vec::new(),
    };
    json!(["ok", answer])
}

/// The bodies the markdown parser refuses, by name: the core declines a node
/// holding one and the TypeScript sizes it (owner decision q72). Every record of
/// these is declined, and no other is.
const DECLINED: &[&str] = &["quote 33 deep", "list 39 deep", "list 40 deep"];

/// The recorded tokens of the fences a `needs` answer names, as `codeTokens` rows.
fn tokens_for(fences: &[Json], table: &[Value]) -> Value {
    let rows = fences.iter().map(|fence| {
        let (lang, code) =
            (fence[0].as_str().unwrap_or_default(), fence[1].as_str().unwrap_or_default());
        let found = table.iter().find(|row| match row {
            Value::Seq(items) => items.first() == Some(&s(lang)) && items.get(1) == Some(&s(code)),
            _ => false,
        });
        let tokens = match found {
            Some(Value::Seq(items)) => items.get(2).cloned().unwrap_or_default(),
            _ => Value::Null,
        };
        Value::Seq(vec![s(lang), s(code), tokens])
    });
    Value::Seq(rows.collect())
}

/// The core's answer, a second call sending the fences' tokens it asked for, as a root does.
fn ask_with_tokens(request: Value, table: &[Value]) -> Json {
    let first = ask(&request);
    if first.get(0) != Some(&json!("needs")) {
        return first;
    }
    let fences = first[1]["code"].as_array().cloned().unwrap_or_default();
    let Value::Map(mut fields) = request else { return first };
    fields.push(("codeTokens".to_owned(), tokens_for(&fences, table)));
    ask(&Value::Map(fields))
}

#[test]
fn the_node_sizes_are_the_recorded_ones() {
    let records = oracle("node-size.jsonl");
    assert_eq!(records.len(), 236, "the recording is read");
    let table = oracle("layout-markdown-fences.jsonl");
    let mut moved = Vec::new();
    let mut declined = 0;
    for record in &records {
        let id = text(record, "id");
        let answer = ask_with_tokens(node_size_request(record), &table);
        let refused = DECLINED.iter().any(|name| id.contains(&format!("/{name}@")));
        if refused {
            declined += 1;
            if answer != json!(["declined", "body"]) {
                moved.push(id);
            }
        } else if answer != hex_answer(record) {
            moved.push(id);
        }
    }
    assert_eq!(declined, 24, "each declined body at two widths, four ways");
    assert!(moved.is_empty(), "{} of {} sizes differ: {moved:?}", moved.len(), records.len());
}

/// A label placement's request: the path, the size and the obstacles as numbers.
fn place_request(record: &Value) -> Value {
    map(vec![
        ("query", s("label-placement")),
        ("path", rows(get(record, "path"))),
        ("size", numbers(get(record, "size"))),
        ("obstacles", rows(get(record, "obstacles"))),
        ("rounded", get(record, "rounded").cloned().unwrap_or(Value::Bool(false))),
    ])
}

/// The runs `frameTitleObstacles` reads, as the rows a root sends: what each annotates, and its box.
fn runs_of(record: &Value) -> Value {
    let Some(Value::Seq(runs)) = get(record, "runs") else { return Value::Seq(Vec::new()) };
    let row = |run: &Value| {
        let annotates = get(run, "annotates").cloned().unwrap_or_default();
        let bbox = get(run, "bbox").cloned().unwrap_or_default();
        let at = |key| get(&bbox, key).cloned().unwrap_or_default();
        Value::Seq(vec![
            s(&text(&annotates, "kind")),
            s(&text(&annotates, "id")),
            Value::Seq(vec![at("x"), at("y"), at("w"), at("h")]),
        ])
    };
    Value::Seq(runs.iter().map(row).collect())
}

fn hexes(value: Option<&Value>) -> Json {
    let hex = |h: &Value| match h {
        Value::String(h) => json!(h),
        _ => Json::Null,
    };
    match value {
        Some(Value::Seq(items)) => Json::Array(
            items
                .iter()
                .map(|item| match item {
                    Value::Seq(row) => Json::Array(row.iter().map(hex).collect()),
                    other => hex(other),
                })
                .collect(),
        ),
        _ => json!([]),
    }
}

#[test]
fn the_edge_label_placements_and_their_obstacles_are_the_recorded_ones() {
    let records = oracle("edge-label-placement.jsonl");
    assert_eq!(records.len(), 272, "the recording is read");
    let mut moved = Vec::new();
    for record in &records {
        let (asked, expected) = if text(record, "kind") == "obstacles" {
            let request = map(vec![
                ("query", s("label-obstacles")),
                ("nodes", get(record, "nodes").cloned().unwrap_or_default()),
                ("runs", runs_of(record)),
            ]);
            let expected =
                json!(["ok", hexes(get(record, "titles")), hexes(get(record, "answer"))]);
            (ask(&request), expected)
        } else {
            let placed = match get(record, "answer") {
                Some(Value::Seq(_)) => hexes(get(record, "answer")),
                _ => json!([]),
            };
            (ask(&place_request(record)), json!(["ok", placed]))
        };
        if asked != expected {
            moved.push(text(record, "id"));
        }
    }
    assert!(moved.is_empty(), "{} of {} placements differ: {moved:?}", moved.len(), records.len());
}

#[test]
fn the_comment_bubbles_are_the_recorded_ones() {
    let records: Vec<Value> = oracle("comment-placement.jsonl")
        .into_iter()
        .filter(|record| text(record, "kind") == "place")
        .collect();
    assert_eq!(records.len(), 235, "the recording is read");
    let mut moved = Vec::new();
    for (i, record) in records.iter().enumerate() {
        let request = map(vec![
            ("query", s("comment-bubble")),
            ("anchor", numbers(get(record, "anchor"))),
            ("size", numbers(get(record, "size"))),
            ("obstacles", rows(get(record, "obstacles"))),
        ]);
        if ask(&request) != json!(["ok", hexes(get(record, "answer"))]) {
            moved.push(i);
        }
    }
    assert!(moved.is_empty(), "{} of {} bubbles differ: {moved:?}", moved.len(), records.len());
}

#[test]
fn the_outline_content_boxes_are_the_recorded_ones() {
    let records = oracle("outline-content-box.jsonl");
    assert_eq!(records.len(), 117, "the recording is read");
    let mut moved = Vec::new();
    for (i, record) in records.iter().enumerate() {
        let mut fields = vec![("query", s("outline-content-box"))];
        if let Some(Value::String(shape)) = get(record, "shape") {
            fields.push(("shape", s(shape)));
        }
        fields.push(("box", numbers(get(record, "box"))));
        if ask(&map(fields)) != json!(["ok", hexes(get(record, "answer"))]) {
            moved.push(format!("{}#{i}", text(record, "shape")));
        }
    }
    assert!(moved.is_empty(), "{} of {} boxes differ: {moved:?}", moved.len(), records.len());
}
