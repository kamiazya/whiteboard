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
use whiteboard_model::canvas_value::canvas_value as lifted;
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

/// The canvas as the recording orders it: the model's value, which follows the
/// TypeScript's lift and puts an edge's `bends` last, with each edge's `bends`
/// back in the contract's place, before its `facets` and `tags`.
fn canvas_value(c: &SpatialCanvas) -> Value {
    let mut value = lifted(c);
    let edges = match &mut value {
        Value::Map(fields) => fields.iter_mut().find(|(key, _)| key == "edges"),
        _ => None,
    };
    if let Some((_, Value::Seq(edges))) = edges {
        for edge in edges {
            if let Value::Map(fields) = edge {
                let at = fields.iter().position(|(key, _)| key == "bends");
                let before = fields.iter().position(|(key, _)| key == "facets" || key == "tags");
                if let (Some(at), Some(before)) = (at, before) {
                    let bends = fields.remove(at);
                    fields.insert(before, bends);
                }
            }
        }
    }
    value
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

    /// A recorded canvas, which the model's reader reads strictly.
    pub(crate) fn canvas_of(value: &Value) -> SpatialCanvas {
        whiteboard_model::canvas_value::canvas_of(value).expect("a recorded canvas")
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
    assert_reached(&agreed, &held_back, cases.len());
}

/// An agreement over nothing passes, so say what the recording reached.
fn assert_reached(agreed: &[String], held_back: &[Decline], total: usize) {
    let count = |what: &str| agreed.iter().filter(|v| v.as_str() == what).count();
    assert!(total > 1300, "{total} texts replayed");
    let declines = |why: Decline| held_back.iter().filter(|d| **d == why).count();
    assert!(held_back.len() < total / 20, "{} of {total} texts declined", held_back.len());
    for why in [Decline::LoneSurrogate, Decline::TooDeep] {
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

#[test]
fn every_recorded_canvas_is_written_as_the_typescript_wrote_it() {
    let recording = recording();
    let cases: Vec<&Json> = recording.iter().filter(|c| c["k"] == "w").collect();
    let mut problems: Vec<String> = Vec::new();
    let (mut written, mut refused) = (0usize, 0usize);
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
}
