//! The JSON Canvas codec against the recorded TypeScript answers.
//!
//! `packages/codec/src/spatial/oracle/json-canvas-recorded-oracle.test.ts`
//! writes `json-canvas.jsonl` from `parseSpatial` and `serializeSpatial` and
//! fails when the file no longer equals what the TypeScript answers; this
//! replays it natively. One JSON object per line.
//!
//! A reader case is the text `"t"` and `"ok"`, the document, or `"err"`: the
//! `stage` and, for the schema, a `class` and each Zod issue as `[path, code]`.
//! A writer case is `"m"`, the mode, `"c"`, the canvas, and `"y"`, the text, or
//! `"err"`, the issues the strict mode's re-validation raised.
//!
//! A document is `{"m": [[key, value], ...]}` for an object, in the order the
//! contract names its fields, since a Rust struct has no order of its own and
//! the TypeScript's follows whoever built the object; a facet payload keeps the
//! order JavaScript enumerates it in. A number that is a safe integer other
//! than `-0` is itself, and any other is `{"f": hex}`, the bits of the double.
//!
//! Refusal messages are not recorded, so agreement is on the stage and, for
//! the schema, where and why. A case the core declines is counted, and each
//! must be one the core says it declines.

use serde_json::{Value as Json, json};
use whiteboard_codec::json_canvas::{
    Code, Decline, Failure, Issue, MAX_DEPTH, Mode, PathStep, SpatialCanvas, WriteFailure, parse,
    serialize,
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

fn recording() -> Vec<Json> {
    let text = include_str!("../../../../packages/codec/src/spatial/oracle/json-canvas.jsonl");
    let lines: Result<Vec<Json>, _> = text.lines().map(serde_json::from_str).collect();
    assert!(
        lines.is_ok(),
        "the recording is not one JSON value per line: {:?}",
        lines.as_ref().err()
    );
    lines.unwrap_or_default()
}

// ---------------------------------------------------------------- the canvas as a Value

type Fields = Vec<(&'static str, Option<Value>)>;

fn object(fields: Fields) -> Value {
    Value::Map(fields.into_iter().filter_map(|(k, v)| Some((k.to_string(), v?))).collect())
}

fn text(s: &str) -> Value {
    Value::String(s.to_string())
}

fn some_text(s: Option<&String>) -> Option<Value> {
    s.map(|s| text(s))
}

fn tags_value(tags: Option<&Vec<String>>) -> Option<Value> {
    tags.map(|t| Value::Seq(t.iter().map(|s| text(s)).collect()))
}

fn facets_value(facets: Option<&Vec<(String, Value)>>) -> Option<Value> {
    facets.map(|f| Value::Map(f.clone()))
}

fn color_value(color: Option<&CanvasColor>) -> Option<Value> {
    color.map(|c| match c {
        CanvasColor::CanvasColorPreset(p) => text(p.as_str()),
        CanvasColor::CanvasColorHex(h) => text(h),
    })
}

fn point_value(p: &CanvasPoint) -> Value {
    object(vec![("x", Some(Value::Number(p.x))), ("y", Some(Value::Number(p.y)))])
}

fn bends_value(bends: Option<&Vec<CanvasPoint>>) -> Option<Value> {
    bends.map(|b| Value::Seq(b.iter().map(point_value).collect()))
}

fn side_value(side: Option<EdgeSide>) -> Option<Value> {
    side.map(|s| text(s.as_str()))
}

fn arrow_value(end: Option<Arrowhead>) -> Option<Value> {
    end.map(|e| text(e.as_str()))
}

fn node_value(n: &SpatialNode) -> Value {
    let embed = n.embed.as_ref().map(|e| {
        object(vec![
            ("documentId", Some(text(&e.document_id))),
            ("versionRef", some_text(e.version_ref.as_ref())),
        ])
    });
    let resource = n.resource.as_ref().map(|r| {
        object(vec![
            ("mimeType", Some(text(&r.mime_type))),
            ("content", some_text(r.content.as_ref())),
            ("location", some_text(r.location.as_ref())),
            ("subpath", some_text(r.subpath.as_ref())),
        ])
    });
    object(vec![
        ("id", Some(text(&n.id))),
        ("x", Some(Value::Number(n.x))),
        ("y", Some(Value::Number(n.y))),
        ("width", Some(Value::Number(n.width))),
        ("height", Some(Value::Number(n.height))),
        ("color", color_value(n.color.as_ref())),
        ("embed", embed),
        ("facets", facets_value(n.facets.as_ref())),
        ("tags", tags_value(n.tags.as_ref())),
        ("resource", resource),
        ("label", some_text(n.label.as_ref())),
        ("background", some_text(n.background.as_ref())),
        ("backgroundStyle", n.background_style.map(|s| text(s.as_str()))),
    ])
}

fn edge_end_value(e: &EdgeEnd) -> Value {
    object(vec![
        ("node", Some(text(&e.node))),
        ("side", side_value(e.side)),
        ("end", arrow_value(e.end)),
    ])
}

fn edge_value(e: &CanvasEdge) -> Value {
    object(vec![
        ("id", Some(text(&e.id))),
        ("from", Some(edge_end_value(&e.from))),
        ("to", Some(edge_end_value(&e.to))),
        ("color", color_value(e.color.as_ref())),
        ("label", some_text(e.label.as_ref())),
        ("bends", bends_value(e.bends.as_ref())),
        ("facets", facets_value(e.facets.as_ref())),
        ("tags", tags_value(e.tags.as_ref())),
    ])
}

fn line_end_value(e: &LineEnd) -> Value {
    match e {
        LineEnd::LineEndNode(n) => object(vec![
            ("kind", Some(text("node"))),
            ("node", Some(text(&n.node))),
            ("side", side_value(n.side)),
            ("end", arrow_value(n.end)),
        ]),
        LineEnd::LineEndPoint(p) => object(vec![
            ("kind", Some(text("point"))),
            ("point", Some(point_value(&p.point))),
            ("end", arrow_value(p.end)),
        ]),
    }
}

fn line_value(l: &CanvasLine) -> Value {
    object(vec![
        ("id", Some(text(&l.id))),
        ("from", Some(line_end_value(&l.from))),
        ("to", Some(line_end_value(&l.to))),
        ("color", color_value(l.color.as_ref())),
        ("label", some_text(l.label.as_ref())),
        ("bends", bends_value(l.bends.as_ref())),
        ("facets", facets_value(l.facets.as_ref())),
    ])
}

fn canvas_value(c: &SpatialCanvas) -> Value {
    object(vec![
        ("nodes", Some(Value::Seq(c.nodes.iter().map(node_value).collect()))),
        ("edges", Some(Value::Seq(c.edges.iter().map(edge_value).collect()))),
        ("lines", c.lines.as_ref().map(|l| Value::Seq(l.iter().map(line_value).collect()))),
        ("facets", facets_value(c.facets.as_ref())),
        ("tags", tags_value(c.tags.as_ref())),
    ])
}

// ---------------------------------------------------------------- the recording's encoding

fn array_index(key: &str) -> Option<u32> {
    whiteboard_model::array_index(key)
}

fn compact(value: &Value) -> Json {
    match value {
        Value::Null => Json::Null,
        Value::Bool(b) => json!(b),
        Value::Number(n) => {
            let whole = n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0;
            if whole && !(*n == 0.0 && n.is_sign_negative()) {
                json!(format!("{n}").parse::<i64>().unwrap_or_default())
            } else {
                json!({"f": format!("{:016x}", n.to_bits())})
            }
        }
        Value::BigInt(digits) => json!({"big": digits}),
        Value::String(s) => json!(s),
        Value::Seq(items) => Json::Array(items.iter().map(compact).collect()),
        Value::Map(entries) => {
            let mut indexed: Vec<_> =
                entries.iter().filter_map(|(k, v)| Some((array_index(k)?, k, v))).collect();
            indexed.sort_by_key(|entry| entry.0);
            let rest = entries.iter().filter(|(k, _)| array_index(k).is_none());
            let ordered =
                indexed.into_iter().map(|(_, k, v)| (k, v)).chain(rest.map(|(k, v)| (k, v)));
            json!({"m": ordered.map(|(k, v)| json!([k, compact(v)])).collect::<Vec<_>>()})
        }
    }
}

#[cfg(test)]
mod recorded {
    //! The recording's encoding read back into values and canvases; a recording
    //! that is not well formed is a failing test, so these may expect.
    use super::*;

    pub(crate) fn expand(json: &Json) -> Value {
        match json {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::String(s) => Value::String(s.clone()),
            Json::Number(n) => Value::Number(n.as_f64().expect("a recorded number")),
            Json::Array(items) => Value::Seq(items.iter().map(expand).collect()),
            Json::Object(object) => {
                if let Some(bits) = object.get("f").and_then(Json::as_str) {
                    let bits = u64::from_str_radix(bits, 16).expect("64 bits of hex");
                    return Value::Number(f64::from_bits(bits));
                }
                let pairs = object.get("m").and_then(Json::as_array).expect("a recorded object");
                Value::Map(
                    pairs
                        .iter()
                        .map(|p| (p[0].as_str().expect("a key").to_string(), expand(&p[1])))
                        .collect(),
                )
            }
        }
    }

    fn field<'a>(entries: &'a [(String, Value)], name: &str) -> Option<&'a Value> {
        entries.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    fn entries(value: &Value) -> &Vec<(String, Value)> {
        match value {
            Value::Map(e) => e,
            other => panic!("{other:?} is no object"),
        }
    }

    fn string_of(value: &Value) -> String {
        match value {
            Value::String(s) => s.clone(),
            other => panic!("{other:?} is no string"),
        }
    }

    fn number_of(value: &Value) -> f64 {
        match value {
            Value::Number(n) => *n,
            other => panic!("{other:?} is no number"),
        }
    }

    fn opt_string(e: &[(String, Value)], name: &str) -> Option<String> {
        field(e, name).map(string_of)
    }

    fn seq_of(value: &Value) -> &Vec<Value> {
        match value {
            Value::Seq(items) => items,
            other => panic!("{other:?} is no list"),
        }
    }

    fn opt_tags(e: &[(String, Value)]) -> Option<Vec<String>> {
        field(e, "tags").map(|t| seq_of(t).iter().map(string_of).collect())
    }

    fn opt_facets(e: &[(String, Value)]) -> Option<Vec<(String, Value)>> {
        field(e, "facets").map(|f| entries(f).clone())
    }

    fn color_of(e: &[(String, Value)]) -> Option<CanvasColor> {
        opt_string(e, "color").map(|c| match CanvasColorPreset::from_wire(&c) {
            Some(preset) => CanvasColor::CanvasColorPreset(preset),
            None => CanvasColor::CanvasColorHex(c),
        })
    }

    fn point_of(value: &Value) -> CanvasPoint {
        let e = entries(value);
        CanvasPoint {
            x: number_of(field(e, "x").expect("x")),
            y: number_of(field(e, "y").expect("y")),
        }
    }

    fn bends_of(e: &[(String, Value)]) -> Option<Vec<CanvasPoint>> {
        field(e, "bends").map(|b| seq_of(b).iter().map(point_of).collect())
    }

    fn side_of(e: &[(String, Value)]) -> Option<EdgeSide> {
        opt_string(e, "side").map(|s| EdgeSide::from_wire(&s).expect("a side"))
    }

    fn arrow_of(e: &[(String, Value)]) -> Option<Arrowhead> {
        opt_string(e, "end").map(|s| Arrowhead::from_wire(&s).expect("an arrowhead"))
    }

    fn node_of(value: &Value) -> SpatialNode {
        let e = entries(value);
        let embed = field(e, "embed").map(|v| {
            let e = entries(v);
            NodeEmbed {
                document_id: opt_string(e, "documentId").expect("documentId"),
                version_ref: opt_string(e, "versionRef"),
            }
        });
        let resource = field(e, "resource").map(|v| {
            let e = entries(v);
            NodeResource {
                mime_type: opt_string(e, "mimeType").expect("mimeType"),
                content: opt_string(e, "content"),
                location: opt_string(e, "location"),
                subpath: opt_string(e, "subpath"),
            }
        });
        SpatialNode {
            id: opt_string(e, "id").expect("id"),
            x: number_of(field(e, "x").expect("x")),
            y: number_of(field(e, "y").expect("y")),
            width: number_of(field(e, "width").expect("width")),
            height: number_of(field(e, "height").expect("height")),
            color: color_of(e),
            embed,
            facets: opt_facets(e),
            tags: opt_tags(e),
            resource,
            label: opt_string(e, "label"),
            background: opt_string(e, "background"),
            background_style: opt_string(e, "backgroundStyle")
                .map(|s| BackgroundStyle::from_wire(&s).expect("a style")),
        }
    }

    fn edge_end_of(value: &Value) -> EdgeEnd {
        let e = entries(value);
        EdgeEnd { node: opt_string(e, "node").expect("node"), side: side_of(e), end: arrow_of(e) }
    }

    fn edge_of(value: &Value) -> CanvasEdge {
        let e = entries(value);
        CanvasEdge {
            id: opt_string(e, "id").expect("id"),
            from: edge_end_of(field(e, "from").expect("from")),
            to: edge_end_of(field(e, "to").expect("to")),
            color: color_of(e),
            label: opt_string(e, "label"),
            bends: bends_of(e),
            facets: opt_facets(e),
            tags: opt_tags(e),
        }
    }

    fn line_end_of(value: &Value) -> LineEnd {
        let e = entries(value);
        if opt_string(e, "kind").as_deref() == Some("node") {
            return LineEnd::LineEndNode(LineEndNode {
                node: opt_string(e, "node").expect("node"),
                side: side_of(e),
                end: arrow_of(e),
            });
        }
        LineEnd::LineEndPoint(LineEndPoint {
            point: point_of(field(e, "point").expect("point")),
            end: arrow_of(e),
        })
    }

    fn line_of(value: &Value) -> CanvasLine {
        let e = entries(value);
        CanvasLine {
            id: opt_string(e, "id").expect("id"),
            from: line_end_of(field(e, "from").expect("from")),
            to: line_end_of(field(e, "to").expect("to")),
            color: color_of(e),
            label: opt_string(e, "label"),
            bends: bends_of(e),
            facets: opt_facets(e),
        }
    }

    pub(crate) fn canvas_of(value: &Value) -> SpatialCanvas {
        let e = entries(value);
        SpatialCanvas {
            nodes: seq_of(field(e, "nodes").expect("nodes")).iter().map(node_of).collect(),
            edges: seq_of(field(e, "edges").expect("edges")).iter().map(edge_of).collect(),
            lines: field(e, "lines").map(|l| seq_of(l).iter().map(line_of).collect()),
            facets: opt_facets(e),
            tags: opt_tags(e),
        }
    }
}
use recorded::{canvas_of, expand};

// ---------------------------------------------------------------- the issues

fn code_name(code: Code) -> &'static str {
    match code {
        Code::InvalidType => "invalid_type",
        Code::TooSmall => "too_small",
        Code::TooBig => "too_big",
        Code::InvalidFormat => "invalid_format",
        Code::InvalidValue => "invalid_value",
        Code::InvalidUnion => "invalid_union",
        Code::Custom => "custom",
    }
}

fn issues_json(issues: &[Issue]) -> Json {
    Json::Array(
        issues
            .iter()
            .map(|issue| {
                let path: Vec<Json> = issue
                    .path
                    .iter()
                    .map(|step| match step {
                        PathStep::Key(name) => json!(name),
                        PathStep::Index(at) => json!(at),
                    })
                    .collect();
                json!([path, code_name(issue.code)])
            })
            .collect(),
    )
}

// ---------------------------------------------------------------- what a decline must be

/// The deepest `[` or `{` nesting of a text, ignoring what sits inside strings.
fn nesting(text: &str) -> usize {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for c in text.chars() {
        if in_string {
            match (escaped, c) {
                (true, _) => escaped = false,
                (false, '\\') => escaped = true,
                (false, '"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '[' | '{' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

/// Whether a text has a `\u` escape of a surrogate, in either letter case.
fn spells_surrogate(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["d8", "d9", "da", "db", "dc", "dd", "de", "df"]
        .iter()
        .any(|unit| lower.contains(&format!("\\u{unit}")))
}

fn declined_rightly(why: Decline, text: &str) -> bool {
    match why {
        Decline::LoneSurrogate => spells_surrogate(text),
        Decline::TooDeep => nesting(text) > MAX_DEPTH,
        Decline::Url => text.contains("\"link\""),
        Decline::TooLarge | Decline::Unwritable => false,
    }
}

// ---------------------------------------------------------------- the readers

enum Verdict {
    Agrees(String),
    Declined(Decline),
    Differs(String),
}

fn refusal_of(failure: &Failure) -> Option<Json> {
    Some(match failure {
        Failure::Syntax => json!({"stage": "json-syntax"}),
        Failure::Conversation => json!({"stage": "json-canvas-schema", "class": "conversation"}),
        Failure::Schema(issues) => json!({
            "stage": "json-canvas-schema",
            "class": "schema",
            "issues": issues_json(issues),
        }),
        Failure::Declined(_) => return None,
    })
}

fn reader_verdict(case: &Json) -> Verdict {
    let text = case["t"].as_str().unwrap_or_default();
    match (parse(text), case.get("ok"), case.get("err")) {
        (Ok(canvas), Some(ok), _) if &compact(&canvas_value(&canvas)) == ok => {
            Verdict::Agrees("value".to_string())
        }
        (Ok(_), Some(_), _) => Verdict::Differs(format!("a different document: {text:?}")),
        (Ok(_), None, err) => Verdict::Differs(format!("accepted, refused as {err:?}: {text:?}")),
        (Err(Failure::Declined(why)), ..) => Verdict::Declined(why),
        (Err(why), None, Some(err)) if refusal_of(&why).as_ref() == Some(err) => {
            let class = err["class"].as_str().unwrap_or("syntax");
            Verdict::Agrees(format!("refusal as {class}"))
        }
        (Err(why), None, err) => {
            Verdict::Differs(format!("refused as {why:?}, by the TypeScript as {err:?}: {text:?}"))
        }
        (Err(why), Some(_), _) => Verdict::Differs(format!("refused ({why:?}), read: {text:?}")),
    }
}

#[test]
fn every_recorded_text_is_read_as_the_typescript_read_it() {
    let recording = recording();
    let cases: Vec<&Json> = recording.iter().filter(|c| c["k"] == "r").collect();
    let mut agreed: Vec<String> = Vec::new();
    let mut held_back: Vec<Decline> = Vec::new();
    let mut problems: Vec<String> = Vec::new();
    for case in &cases {
        match reader_verdict(case) {
            Verdict::Agrees(what) => agreed.push(what),
            Verdict::Declined(why) => {
                held_back.push(why);
                let text = case["t"].as_str().unwrap_or_default();
                if !declined_rightly(why, text) {
                    problems.push(format!("declined as {why:?} for no reason: {text:?}"));
                }
            }
            Verdict::Differs(what) => problems.push(what),
        }
    }
    assert!(
        problems.is_empty(),
        "{} of {} texts disagree, the first: {:#?}",
        problems.len(),
        cases.len(),
        &problems[..problems.len().min(8)]
    );
    // An agreement over nothing passes, so say what the recording reached.
    let count = |what: &str| agreed.iter().filter(|v| v.as_str() == what).count();
    assert!(cases.len() > 1300, "{} texts replayed", cases.len());
    let declines = |why: Decline| held_back.iter().filter(|d| **d == why).count();
    assert!(
        held_back.len() < cases.len() / 20,
        "{} of {} texts declined",
        held_back.len(),
        cases.len()
    );
    for why in [Decline::LoneSurrogate, Decline::TooDeep, Decline::Url] {
        assert!(declines(why) > 2, "{} texts declined as {why:?}", declines(why));
    }
    assert!(count("value") > 650, "{} texts read to a document", count("value"));
    assert!(
        count("refusal as schema") > 400,
        "{} texts refused by the schema",
        count("refusal as schema")
    );
    assert!(count("refusal as syntax") > 100, "{} texts are not JSON", count("refusal as syntax"));
    assert!(
        count("refusal as conversation") > 3,
        "{} files hold comments",
        count("refusal as conversation")
    );
}

#[test]
fn every_recorded_refusal_names_the_codes_the_schema_raises() {
    let recording = recording();
    let issues: Vec<&Json> = recording
        .iter()
        .filter(|c| c["k"] == "r")
        .filter_map(|c| c["err"]["issues"].as_array())
        .flatten()
        .collect();
    for code in [
        Code::InvalidType,
        Code::TooSmall,
        Code::TooBig,
        Code::InvalidFormat,
        Code::InvalidValue,
        Code::InvalidUnion,
        Code::Custom,
    ] {
        let raised = issues.iter().filter(|i| i[1] == code_name(code)).count();
        assert!(raised > 3, "{raised} issues coded {}", code_name(code));
    }
}

// ---------------------------------------------------------------- the writers

fn write_mode(case: &Json) -> Mode {
    if case["m"] == "strict" { Mode::Strict } else { Mode::Extended }
}

fn has_link(canvas: &SpatialCanvas) -> bool {
    canvas.nodes.iter().any(|n| {
        n.resource.as_ref().is_some_and(|r| r.mime_type == "text/uri-list" && r.location.is_some())
    })
}

#[test]
fn every_recorded_canvas_is_written_as_the_typescript_wrote_it() {
    let recording = recording();
    let cases: Vec<&Json> = recording.iter().filter(|c| c["k"] == "w").collect();
    let mut problems: Vec<String> = Vec::new();
    let (mut written, mut refused, mut declined) = (0usize, 0usize, 0usize);
    for case in &cases {
        let canvas = canvas_of(&expand(&case["c"]));
        match (
            serialize(&canvas, write_mode(case)),
            case.get("y").and_then(Json::as_str),
            case.get("err"),
        ) {
            (Ok(text), Some(y), _) if text == y => written += 1,
            (Err(WriteFailure::Schema(issues)), None, Some(err))
                if issues_json(&issues) == err["issues"] =>
            {
                refused += 1;
            }
            (Err(WriteFailure::Declined(Decline::Url)), ..) if has_link(&canvas) => declined += 1,
            (answer, y, err) => {
                problems
                    .push(format!("rust {answer:?}, typescript {y:?} {err:?}, for {}", case["c"]));
            }
        }
    }
    assert!(
        problems.is_empty(),
        "{} of {} canvases disagree, the first: {:#?}",
        problems.len(),
        cases.len(),
        &problems[..problems.len().min(4)]
    );
    assert!(cases.len() > 550, "{} canvases replayed", cases.len());
    assert!(written > 400, "{written} canvases written");
    assert!(refused > 80, "{refused} canvases refused by the strict mode");
    assert!(declined > 3 && declined < cases.len() / 10, "{declined} canvases declined");
}
